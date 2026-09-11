/**
 * api.js — Cliente Supabase (núcleo do PDV)
 *
 * Substitui a API REST do Base44. Mantém os mesmos nomes de função
 * exportados usados por sync.js e main.js. Funções fora do escopo desta
 * fase (marketplace, NFC-e, WhatsApp, orçamentos, entregas, IA) viram
 * stubs que retornam erro amigável em vez de apontar para o Base44.
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const Store = require('electron-store');
const store = new Store();
const supabase = require('./supabaseClient');

// `app` do Electron so para a versao; require tardio evita ciclo com main.js.
function app_getVersion() {
  try { return require('electron').app.getVersion(); } catch { return null; }
}

function _naoDisponivel(nome) {
  return async () => {
    throw new Error(`${nome}: recurso ainda não migrado nesta versão do VargasNexus PDV`);
  };
}

// Terminais que já rodaram o antigo PDV Base44 podem ter remote_id de
// cliente/produto herdado daquele sistema em cache local — um ObjectId de
// 24 caracteres hex, não um UUID. Mandar isso pro Supabase como chave
// estrangeira quebra com "invalid input syntax for type uuid" e a venda
// fica pendente pra sempre (o valor nunca muda entre tentativas). Em vez
// de confiar cegamente num remote_id em cache, valida o formato antes de
// usar — se não for um UUID de verdade, trata como não vinculado (null)
// em vez de travar a venda inteira por causa de um vínculo velho.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function _comoUuid(valor) {
  return typeof valor === 'string' && UUID_RE.test(valor) ? valor : null;
}

// ─── Ping ─────────────────────────────────────────────────────────────

async function ping() {
  try {
    const { error } = await supabase.from('produtos').select('id', { count: 'exact', head: true }).limit(1);
    return !error;
  } catch { return false; }
}

// ─── Estoque (interno) ──────────────────────────────────────────────

// Resolve o depósito a usar para o ajuste por depósito e para o registro de
// movimentação: o indicado explicitamente por quem chamou (ex: o depósito
// onde a venda original aconteceu, pra devolução voltar pro mesmo lugar),
// senão o do operador logado, senão o principal da empresa. Nunca inventa
// um depósito — se nenhum existir, devolve null e quem chamou pula o ajuste.
async function _resolverDepositoAjuste(depositoIdHint, empresaId) {
  if (depositoIdHint) return depositoIdHint;
  const usuario = store.get('auth.usuario') || {};
  if (usuario.deposito_id) return usuario.deposito_id;
  if (!empresaId) return null;
  const { data: principal } = await supabase.from('depositos')
    .select('id').eq('empresa_id', empresaId).eq('principal', true).maybeSingle();
  return principal?.id || null;
}

// Espelha o ajuste de estoque na linha de produto_estoque do par
// (produto, depósito) — é o que a tela de estoque por depósito do painel
// web lê. Cria a linha se ainda não existir.
//
// A versão anterior descartava o erro do INSERT e tratava QUALQUER falha
// como "outra escrita criou a linha primeiro": voltava ao topo do laço e,
// depois de 5 voltas, desistia dizendo "conflito de concorrência". Como a
// maioria dos produtos ainda não tem linha neste depósito, o caminho normal
// é o INSERT — e um INSERT recusado (privilégio, coluna obrigatória,
// constraint) virava, na leitura de quem investigava, um problema de
// concorrência que nunca existiu. Agora o erro é lido: só é conflito quando
// o banco diz que é (23505, chave duplicada); o resto é falha e volta como
// falha, com a mensagem do banco junto.
async function _ajustarEstoqueDeposito(produtoId, delta, depositoId, empresaId) {
  let ultimoMotivo = null;

  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const { data: linha, error: errSel } = await supabase.from('produto_estoque')
      .select('id, quantidade').eq('produto_id', produtoId).eq('deposito_id', depositoId).maybeSingle();
    if (errSel) return { ok: false, motivo: `leitura de produto_estoque: ${errSel.message}` };

    if (!linha) {
      const { error: errIns } = await supabase.from('produto_estoque').insert({
        empresa_id: empresaId, deposito_id: depositoId, produto_id: produtoId, quantidade: delta,
      });
      if (!errIns) return { ok: true };
      // 23505 = a linha nasceu entre o select e o insert. Aí sim vale voltar
      // ao topo e tratá-la como update. Qualquer outro erro é erro.
      if (errIns.code !== '23505') return { ok: false, motivo: `insert em produto_estoque: ${errIns.message} (${errIns.code})` };
      ultimoMotivo = 'linha criada por outra escrita durante o insert';
      continue;
    }

    const novaQuantidade = Number(linha.quantidade || 0) + delta;
    const { data: atualizado, error: errUpd } = await supabase.from('produto_estoque')
      .update({ quantidade: novaQuantidade })
      .eq('id', linha.id).eq('quantidade', linha.quantidade)
      .select('id').maybeSingle();
    if (errUpd) return { ok: false, motivo: `update em produto_estoque: ${errUpd.message} (${errUpd.code})` };
    if (atualizado) return { ok: true };
    ultimoMotivo = 'quantidade mudou entre a leitura e a gravação';
  }

  return { ok: false, motivo: `5 tentativas sem sucesso — ${ultimoMotivo || 'sem detalhe'}` };
}

// Baixa (delta < 0) ou devolve (delta > 0) estoque no Supabase, nas três
// tabelas que precisam andar juntas: produtos.estoque (saldo consolidado),
// produto_estoque.quantidade (saldo por depósito) e estoque_movimentacoes
// (o rastro). Devolve o que aconteceu em cada uma — quem chama decide o que
// fazer com a parte que não deu certo, em vez de nunca ficar sabendo.
//
// contexto: { produtoNome, tipo ('venda'|'devolucao'), referenciaId,
// referenciaTipo, depositoId, empresaId, motivo, observacao }
async function _ajustarEstoqueCAS(produtoId, delta, contexto = {}) {
  const usuario = store.get('auth.usuario') || {};
  // O empresa_id do contexto (o da própria venda) entra como fallback: sem
  // ele, uma sessão sem operador em cache mandava empresa_id undefined e o
  // insert da movimentação morria em NOT NULL — de novo, calado.
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id || contexto.empresaId || null;

  if (!produtoId) {
    console.warn('[ESTOQUE] Item sem produto_id resolvido — nada foi baixado para', contexto.produtoNome || '(sem nome)');
    return { ok: false, etapa: 'produto', motivo: 'item sem produto_id resolvido no Supabase' };
  }

  const depositoId = await _resolverDepositoAjuste(contexto.depositoId, empresaId);

  let estoqueAnterior = null, estoqueNovo = null, venceu = false, motivoCAS = null;
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const { data: produto, error: errSel } = await supabase.from('produtos')
      .select('estoque').eq('id', produtoId).single();
    if (errSel || !produto) {
      const motivo = errSel ? `${errSel.message} (${errSel.code})` : 'produto não encontrado no Supabase';
      console.warn(`[ESTOQUE] Não deu para ler o estoque de ${produtoId}: ${motivo}`);
      return { ok: false, etapa: 'produtos.select', motivo };
    }

    const novoEstoque = Number(produto.estoque || 0) + delta;
    const { data: atualizado, error: errUpd } = await supabase.from('produtos')
      .update({ estoque: novoEstoque })
      .eq('id', produtoId).eq('estoque', produto.estoque)
      .select('id').maybeSingle();

    // Erro é erro: sem esta distinção, um UPDATE recusado por privilégio se
    // disfarçava de disputa entre dois caixas e sumia depois de 5 voltas.
    if (errUpd) {
      const motivo = `${errUpd.message} (${errUpd.code})`;
      console.warn(`[ESTOQUE] UPDATE em produtos recusado para ${produtoId}: ${motivo}`);
      return { ok: false, etapa: 'produtos.update', motivo };
    }

    if (atualizado) {
      // Grava os valores da tentativa que VENCEU o CAS — se gravasse os da
      // primeira tentativa e ela tivesse perdido para uma venda concorrente,
      // o extrato de movimentação contaria uma história que não aconteceu.
      estoqueAnterior = Number(produto.estoque || 0);
      estoqueNovo = novoEstoque;
      venceu = true;
      break;
    }
    motivoCAS = 'o saldo mudou entre a leitura e a gravação';
  }

  if (!venceu) {
    console.warn(`[ESTOQUE] 5 tentativas sem baixar ${produtoId} — ${motivoCAS}`);
    return { ok: false, etapa: 'produtos.update', motivo: `5 tentativas sem sucesso — ${motivoCAS}` };
  }

  // Daqui em diante o saldo consolidado já foi baixado de verdade. O que
  // falhar abaixo não derruba a venda, mas volta relatado para quem chamou:
  // é dívida a acertar, não silêncio.
  const pendencias = [];

  if (depositoId) {
    try {
      const r = await _ajustarEstoqueDeposito(produtoId, delta, depositoId, empresaId);
      if (!r.ok) {
        console.warn(`[ESTOQUE] produto_estoque não ajustado para ${produtoId}: ${r.motivo}`);
        pendencias.push({ etapa: 'produto_estoque', motivo: r.motivo });
      }
    } catch (err) {
      console.warn('[ESTOQUE] Falha ao ajustar produto_estoque:', err.message);
      pendencias.push({ etapa: 'produto_estoque', motivo: err.message });
    }
  } else {
    const motivo = 'sem depósito do operador nem principal da empresa';
    console.warn(`[ESTOQUE] ${motivo} — produto_estoque não ajustado para ${produtoId}`);
    pendencias.push({ etapa: 'produto_estoque', motivo });
  }

  try {
    // Sem .select() de propósito: o papel anônimo perdeu SELECT nesta tabela
    // em 30/08/2026 (supabase-fechar-anon-onda1.sql, §4). O terminal escreve
    // aqui e nunca lê — pedir a linha de volta faria o INSERT ser recusado
    // com 42501 mesmo tendo permissão de inserir.
    const { error: errMov } = await supabase.from('estoque_movimentacoes').insert({
      empresa_id: empresaId,
      deposito_id: depositoId,
      produto_id: produtoId,
      produto_nome: contexto.produtoNome || null,
      tipo: contexto.tipo || (delta < 0 ? 'venda' : 'devolucao'),
      quantidade: Math.abs(delta),
      estoque_anterior: estoqueAnterior,
      estoque_novo: estoqueNovo,
      motivo: contexto.motivo || null,
      referencia_id: contexto.referenciaId || null,
      referencia_tipo: contexto.referenciaTipo || 'venda',
      usuario: usuario.nome || null,
      observacao: contexto.observacao || null,
    });
    if (errMov) {
      const motivo = `${errMov.message} (${errMov.code})`;
      console.warn(`[ESTOQUE] Movimentação de ${produtoId} não registrada: ${motivo}`);
      pendencias.push({ etapa: 'estoque_movimentacoes', motivo });
    }
  } catch (err) {
    console.warn('[ESTOQUE] Movimentação não registrada:', err.message);
    pendencias.push({ etapa: 'estoque_movimentacoes', motivo: err.message });
  }

  return { ok: true, baixou: true, estoqueAnterior, estoqueNovo, pendencias };
}

// ─── Produtos ─────────────────────────────────────────────────────────

async function sincronizarProdutos(ultimaSync = null, onBatch = null) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  const pageSize = 500;
  let from = 0;
  let totalBaixados = 0;
  const todos = [];

  while (true) {
    // Sem filtro de ativo aqui: um produto que virou inativo no web
    // precisa continuar aparecendo nesta consulta (o updated_at dele mudou)
    // para que o terminal receba a baixa e pare de vender. Quem decide o
    // que pode ser vendido é o filtro local (produtos.buscar), não este.
    let query = supabase.from('produtos').select('*').range(from, from + pageSize - 1).order('nome').order('id');
    if (empresaId) query = query.eq('empresa_id', empresaId);
    if (ultimaSync) query = query.gte('updated_at', ultimaSync);

    const { data, error } = await query;
    if (error) throw new Error(`Supabase produtos: ${error.message}`);
    const items = data || [];

    if (items.length > 0) {
      totalBaixados += items.length;
      if (onBatch) onBatch(items, totalBaixados);
      else todos.push(...items);
    }
    if (items.length < pageSize) break;
    from += pageSize;
  }

  return onBatch ? totalBaixados : todos;
}

async function contarProdutosRemoto() {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  let query = supabase.from('produtos').select('id', { count: 'exact', head: true }).eq('ativo', true);
  if (empresaId) query = query.eq('empresa_id', empresaId);
  const { count, error } = await query;
  if (error) throw new Error(`Supabase produtos (count): ${error.message}`);
  return count || 0;
}

async function getProduto(id) {
  const { data, error } = await supabase.from('produtos').select('*').eq('id', id).single();
  if (error) throw new Error(error.message);
  return data;
}

// Produto cadastrado no balcão (tela "Novo Produto") — ainda não existe no
// Supabase. Sem isso, o produto nunca ganha remote_id e qualquer venda dele
// vira um item "órfão" no Supabase (produto_id sem correspondência real).
// INSERT direto em produtos foi revogado do anon — passa por
// criar_produto_pdv (SECURITY DEFINER), ver supabase-rpc-pdv-vendas-produtos.sql.
async function criarProdutoRemoto(produto) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  const { data, error } = await supabase.rpc('criar_produto_pdv', {
    p_empresa_id: empresaId,
    p_nome: produto.nome,
    p_sku: produto.sku || null,
    p_ean: produto.ean || null,
    p_preco_venda: produto.preco_venda || 0,
    p_preco_custo: produto.preco_custo || 0,
    p_unidade: produto.unidade || 'UN',
    p_categoria: produto.categoria || null,
    p_marca: produto.marca || null,
    p_foto_url: produto.foto_url || null,
    p_ativo: produto.ativo !== false,
    p_permite_fracao: !!produto.permite_fracao,
    p_estoque: produto.estoque || 0,
  });
  if (error) throw new Error(error.message);
  const linha = Array.isArray(data) ? data[0] : data;
  return { id: linha.id };
}

async function atualizarProduto(remoteId, dados) {
  const payload = {};
  if (dados.ncm !== undefined) payload.ncm = dados.ncm;
  if (dados.cfop !== undefined) payload.cfop = dados.cfop;
  if (dados.icms_cst !== undefined) payload.icms_cst = dados.icms_cst;
  if (dados.icms_origem !== undefined) payload.icms_origem = dados.icms_origem;
  if (dados.pis_cst !== undefined) payload.pis_cst = dados.pis_cst;
  if (dados.cofins_cst !== undefined) payload.cofins_cst = dados.cofins_cst;
  if (dados.disponivel_pdv !== undefined) payload.disponivel_pdv = !!dados.disponivel_pdv;
  if (dados.nome !== undefined) payload.nome = dados.nome;
  if (dados.preco_venda !== undefined) payload.preco_venda = dados.preco_venda;
  if (dados.preco_custo !== undefined) payload.preco_custo = dados.preco_custo;
  if (dados.categoria !== undefined) payload.categoria = dados.categoria;
  if (dados.marca !== undefined) payload.marca = dados.marca;
  if (dados.unidade !== undefined) payload.unidade = dados.unidade;
  const { data, error } = await supabase.from('produtos').update(payload).eq('id', remoteId).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function sincronizarEstoque() {
  // Estoque vive na coluna produtos.estoque — já vem junto da sincronização de produtos.
  return [];
}

// ─── Vendas ───────────────────────────────────────────────────────────

// _comoUuid() só valida o FORMATO do remote_id em cache — não pega o caso
// de um UUID bem formado que não existe mais no Supabase (ex: era uma das
// duplicatas removidas na limpeza de clientes). Isso só aparece na hora do
// INSERT, como violação da FK vendas_cliente_id_fkey. Resolve de novo pelo
// cadastro equivalente (ou cria, se realmente não existir) em vez de
// desistir — pra venda com forma de pagamento carteira/fiado, cliente_id é
// o que amarra a dívida a alguém de verdade, não dá pra cair pra null.
async function _resolverOuCriarClienteRemoto(clienteLocal, empresaId) {
  if (!clienteLocal?.nome) return null;
  const cli = await registrarCliente(clienteLocal, empresaId);
  return cli?.id || null;
}

async function registrarVenda(venda) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id || venda.empresa_id;
  const itensPayload = (venda.itens || []).map(i => ({
    // Nunca usar i.produto_id (id local do SQLite) como fallback — isso
    // manda um UUID que parece válido mas não existe no Supabase, gerando
    // um item "órfão" sem bloquear o resto da venda. Sem remote_id ainda
    // resolvido (produto criado offline, sync não rodou), fica null — o
    // sistema web já trata null como "sem produto vinculado" corretamente.
    // _comoUuid() cobre também o remote_id herdado do Base44 (24 chars,
    // não é UUID) que pode estar em cache em terminais antigos.
    produto_id: _comoUuid(i.produto_remote_id),
    produto_nome: i.produto_nome,
    produto_sku: i.produto_sku || null,
    quantidade: i.quantidade,
    preco_unitario: i.preco_unitario,
    desconto: i.desconto || 0,
    subtotal: i.total,
  }));

  const depositoIdVenda = usuario.deposito_id || venda.deposito_id || null;
  const falhasEstoque = [];

  let clienteIdVenda = _comoUuid(venda.cliente_remote_id);
  const montarInsert = () => ({
    // FASE 0.6C.6A — a identidade da venda vai junto.
    //
    // Ate aqui o `id` local (uuidv4) nunca era enviado: o Postgres gerava o
    // seu, e o servidor nao tinha como saber que duas insercoes eram a MESMA
    // venda. Foi assim que nasceram quatro pares de vendas duplicadas em 30
    // dias — uma delas com 13 HORAS de intervalo, assinatura de retry —, cada
    // par baixando estoque duas vezes.
    //
    // Com o id explicito, um reenvio bate na PK e o servidor reconhece. E o
    // `.select()` seguinte confirma pelo id, nao por numero+total+janela.
    id: venda.id,
    empresa_id: empresaId,
    empresa_fiscal_id: usuario.empresa_fiscal_id || empresaId,
    deposito_id: depositoIdVenda,
    numero: venda.numero,
    cliente_id: clienteIdVenda,
    cliente_nome: venda.cliente_nome || null,
    status: venda.status || 'concluida',
    tipo_operacao: 'venda',
    subtotal: venda.subtotal,
    desconto: venda.desconto || 0,
    desconto_total: venda.desconto || 0,
    total: venda.total,
    forma_pagamento: venda.forma_pagamento,
    valor_pago: venda.valor_pago || venda.total,
    valor_recebido: venda.valor_pago || venda.total,
    troco: venda.troco || 0,
    observacao: venda.observacao || null,
    terminal_id: store.get('config.terminal_id') || 'PDV-001',
    operador_nome: usuario.nome || null,
    vendedor_id: _comoUuid(venda.vendedor_id),
    vendedor_nome: venda.vendedor_nome || null,
    vendedor_codigo: venda.vendedor_codigo || null,
    itens: itensPayload,
  });

  let { data: novaVenda, error } = await supabase.from('vendas').insert(montarInsert()).select().single();

  // A venda ja esta la? Entao o envio anterior chegou e so a resposta se
  // perdeu. Conferir POR ID — que agora e nosso — e o que distingue "ja
  // gravou" de "falhou", sem heuristica de numero, total e janela de tempo.
  if (error && venda.id) {
    const { data: existente } = await supabase.from('vendas')
      .select('*').eq('id', venda.id).maybeSingle();
    if (existente) {
      console.log(`[VENDA] ${venda.id} ja estava no servidor — reenvio reconhecido`);
      return existente;
    }
  }

  if (error?.message?.includes('vendas_cliente_id_fkey') && clienteIdVenda) {
    console.warn('[VENDA] cliente_id não existe mais no Supabase, resolvendo de novo por nome+telefone:', clienteIdVenda);
    clienteIdVenda = await _resolverOuCriarClienteRemoto(
      { nome: venda.cliente_nome, telefone: venda.cliente_telefone }, empresaId
    );
    ({ data: novaVenda, error } = await supabase.from('vendas').insert(montarInsert()).select().single());
  }

  if (error) throw new Error(`Supabase registrarVenda: ${error.message}`);

  if (itensPayload.length) {
    const { error: errItens } = await supabase.from('venda_itens').insert(
      itensPayload.map(i => ({
        venda_id: novaVenda.id,
        produto_id: i.produto_id,
        produto_nome: i.produto_nome,
        produto_sku: i.produto_sku,
        quantidade: i.quantidade,
        preco_unitario: i.preco_unitario,
        desconto: i.desconto,
        total: i.subtotal,
        tipo: 'venda',
      }))
    );
    if (errItens) console.warn('[VENDA] Erro ao inserir venda_itens:', errItens.message);

    for (const i of itensPayload) {
      const contexto = {
        produtoNome: i.produto_nome, tipo: 'venda',
        referenciaId: novaVenda.id, referenciaTipo: 'venda',
        depositoId: depositoIdVenda, empresaId,
      };
      const r = await _ajustarEstoqueCAS(i.produto_id, -Number(i.quantidade || 0), contexto);
      // O que não baixou volta descrito, com o necessário para tentar de
      // novo. Antes isso morria dentro da função e a venda seguia como se
      // o estoque tivesse saído — foi assim que 343 produtos ficaram com
      // saldo alto demais sem ninguém perceber.
      if (!r.ok) {
        falhasEstoque.push({ produto_id: i.produto_id, produto_nome: i.produto_nome,
          delta: -Number(i.quantidade || 0), contexto, etapa: r.etapa, motivo: r.motivo });
      } else if (r.pendencias?.length) {
        for (const p of r.pendencias) {
          falhasEstoque.push({ produto_id: i.produto_id, produto_nome: i.produto_nome,
            delta: -Number(i.quantidade || 0), contexto, etapa: p.etapa, motivo: p.motivo,
            saldoJaBaixado: true });
        }
      }
    }
  }

  if (falhasEstoque.length) {
    console.warn(`[VENDA] #${venda.numero}: ${falhasEstoque.length} pendência(s) de estoque —`,
      falhasEstoque.map(f => `${f.produto_nome}: ${f.etapa} (${f.motivo})`).join(' | '));
  }

  return { id: novaVenda.id, cliente_id_usado: clienteIdVenda, falhasEstoque };
}

// UPDATE em vendas e DELETE em venda_itens foram revogados do anon — passa
// por editar_venda_pdv (SECURITY DEFINER), que faz as duas coisas junto
// com o insert dos itens novos numa função só. Ver supabase-rpc-pdv-vendas-produtos.sql.
async function editarVenda(remoteId, itens, totais, forma_pagamento) {
  const itensPayload = itens.map(i => ({
    // Nunca usar i.produto_id (id local do SQLite) como fallback — isso
    // manda um UUID que parece válido mas não existe no Supabase, gerando
    // um item "órfão" sem bloquear o resto da venda. Sem remote_id ainda
    // resolvido (produto criado offline, sync não rodou), fica null — o
    // sistema web já trata null como "sem produto vinculado" corretamente.
    produto_id: _comoUuid(i.produto_remote_id),
    produto_nome: i.produto_nome,
    produto_sku: i.produto_sku || null,
    quantidade: i.quantidade,
    preco_unitario: i.preco_unitario,
    desconto: i.desconto || 0,
    total: i.total,
  }));

  const { error } = await supabase.rpc('editar_venda_pdv', {
    p_venda_id: remoteId,
    p_subtotal: totais.subtotal,
    p_desconto: totais.desconto || 0,
    p_total: totais.total,
    p_forma_pagamento: forma_pagamento,
    p_valor_pago: totais.valor_pago || totais.total,
    p_troco: totais.troco || 0,
    p_itens: itensPayload,
  });
  if (error) throw new Error(error.message);
  return { ok: true };
}

// UPDATE em vendas foi revogado do anon — passa por cancelar_venda_pdv
// (SECURITY DEFINER, ver supabase-rpc-pdv-vendas-produtos.sql), que só
// marca 'cancelada' se ainda estiver 'concluida'. Por isso ela roda ANTES
// de reverter o estoque, não depois: se a venda já tinha sido cancelada
// (0 linhas voltam), não reverte o estoque de novo — a ordem antiga
// (reverte primeiro, marca status depois) deixava o estoque já revertido
// órfão de uma venda que continuava 'concluida' sempre que o UPDATE
// falhasse, com risco real de reversão dupla numa segunda tentativa.
async function cancelarVenda(remoteId, motivo) {
  const { data: linhas, error } = await supabase.rpc('cancelar_venda_pdv', {
    p_venda_id: remoteId, p_motivo: motivo || null,
  });
  if (error) throw new Error(error.message);
  if (!linhas || !linhas.length) {
    // Já estava cancelada (ou a venda não existe) — nada a reverter.
    return { ok: true, jaCancelada: true };
  }
  const depositoIdVenda = linhas[0].deposito_id || null;

  const { data: itens } = await supabase.from('venda_itens').select('produto_id, produto_nome, quantidade').eq('venda_id', remoteId);
  const falhasEstoque = [];
  for (const i of itens || []) {
    const contexto = {
      produtoNome: i.produto_nome, tipo: 'devolucao',
      referenciaId: remoteId, referenciaTipo: 'venda',
      motivo, depositoId: depositoIdVenda,
    };
    const r = await _ajustarEstoqueCAS(i.produto_id, Number(i.quantidade || 0), contexto);
    if (!r.ok) {
      falhasEstoque.push({ produto_id: i.produto_id, produto_nome: i.produto_nome,
        delta: Number(i.quantidade || 0), contexto, etapa: r.etapa, motivo: r.motivo });
    }
  }
  if (falhasEstoque.length) {
    console.warn(`[VENDA] Cancelamento ${remoteId}: ${falhasEstoque.length} item(ns) não voltaram ao estoque —`,
      falhasEstoque.map(f => `${f.produto_nome}: ${f.motivo}`).join(' | '));
  }
  return { ok: true, falhasEstoque };
}

// Movimentação avulsa (entrada, ajuste, perda) lançada no próprio terminal.
//
// sync.js já chamava api.enviarMovimentacaoEstoque() para a entidade
// 'estoque' da fila, mas a função nunca existiu neste módulo depois da
// migração do Base44 para o Supabase: a chamada estourava
// "api.enviarMovimentacaoEstoque is not a function", a fila marcava erro e
// nenhuma movimentação lançada no balcão jamais subiu.
async function enviarMovimentacaoEstoque(mov) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id || mov.empresa_id || null;

  // A quantidade local é sempre positiva; é o tipo que diz a direção — o
  // mesmo contrato que a baixa de venda usa em estoque_movimentacoes.
  const quantidade = Math.abs(Number(mov.quantidade || 0));
  const entrada = ['entrada', 'devolucao', 'ajuste_positivo'].includes(mov.tipo);
  const delta = entrada ? quantidade : -quantidade;

  const produtoId = _comoUuid(mov.produto_remote_id) || _comoUuid(mov.produto_id);
  if (!produtoId) throw new Error('Movimentação sem produto sincronizado no Supabase');

  const r = await _ajustarEstoqueCAS(produtoId, delta, {
    produtoNome: mov.produto_nome, tipo: mov.tipo || (entrada ? 'entrada' : 'saida'),
    referenciaId: _comoUuid(mov.referencia_id), referenciaTipo: mov.referencia_tipo || 'ajuste',
    depositoId: mov.deposito_id || usuario.deposito_id || null,
    empresaId, motivo: mov.motivo || null, observacao: mov.observacao || null,
  });
  if (!r.ok) throw new Error(`Estoque não ajustado (${r.etapa}): ${r.motivo}`);
  return { ok: true, pendencias: r.pendencias || [] };
}

async function listarVendasCloud(data) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  const inicio = `${data}T00:00:00`;
  const fim = `${data}T23:59:59.999`;
  let query = supabase.from('vendas').select('*').gte('created_at', inicio).lte('created_at', fim).order('created_at', { ascending: false }).limit(500);
  if (empresaId) query = query.eq('empresa_id', empresaId);
  const { data: lista, error } = await query;
  if (error) throw new Error(error.message);
  return lista || [];
}

// ─── Vendedores ───────────────────────────────────────────────────────

async function sincronizarVendedores() {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;

  let vendedorIds = null;
  if (empresaId) {
    const { data: vinculos } = await supabase.from('vendedor_empresas').select('vendedor_id').eq('empresa_id', empresaId).eq('ativo', true);
    vendedorIds = (vinculos || []).map(v => v.vendedor_id);
    if (!vendedorIds.length) return [];
  }

  let query = supabase.from('vendedores').select('*').eq('ativo', true);
  if (vendedorIds) query = query.in('id', vendedorIds);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

// ─── Clientes ─────────────────────────────────────────────────────────

// Nome comparável: sem acento, sem espaço duplicado, caixa alta. Precisa
// bater EXATAMENTE com cliente_chave_dedup() do banco
// (supabase-clientes-antiduplicacao.sql), senão PDV e Supabase discordam
// sobre o que é o mesmo cliente e a duplicata volta por outra porta.
const _ACENTOS = { á:'a',à:'a',ã:'a',â:'a',ä:'a',é:'e',è:'e',ê:'e',ë:'e',í:'i',ì:'i',î:'i',ï:'i',
                   ó:'o',ò:'o',õ:'o',ô:'o',ö:'o',ú:'u',ù:'u',û:'u',ü:'u',ç:'c',ñ:'n' };
function _chaveNome(nome) {
  return (nome || '')
    .toLowerCase()
    .replace(/[áàãâäéèêëíìîïóòõôöúùûüçñ]/g, c => _ACENTOS[c] || c)
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}
const _soDigitos = v => (v || '').replace(/\D/g, '');

// Dois cadastros são a mesma pessoa quando o nome bate e nada os
// desmente: telefone e CPF/CNPJ ou são iguais, ou um dos lados está
// vazio. É a parte que faltava — telefone diferente NÃO é o critério de
// separação sozinho (a loja tem "SILVANO" e "SILVANO VARGAS" no mesmo
// número, gente de casa dividindo telefone), mas telefone vazio de um
// lado também não pode inventar um cadastro novo, que foi exatamente o
// que encheu o sistema web de cópias.
function _mesmoCliente(local, remoto) {
  if (_chaveNome(local.nome) !== _chaveNome(remoto.nome)) return false;
  const telL = _soDigitos(local.telefone), telR = _soDigitos(remoto.telefone);
  if (telL && telR && telL !== telR) return false;
  const docL = _soDigitos(local.cpf_cnpj), docR = _soDigitos(remoto.cpf_cnpj);
  if (docL && docR && docL !== docR) return false;
  return true;
}

// Procura o cadastro que já existe no Supabase antes de criar outro.
// CPF/CNPJ tem prioridade: é identidade de verdade, vale mesmo com o nome
// escrito diferente. Depois cai pro nome + compatibilidade de telefone.
//
// `mesclado_em` é seguido até o sobrevivente: um cadastro que foi
// unificado no sistema web continua existindo, e devolver o id dele faria
// a venda nascer pendurada num cliente morto.
async function _acharClienteRemoto(cliente, empresaId) {
  const doc = _soDigitos(cliente.cpf_cnpj);
  if (doc) {
    const { data } = await supabase.from('clientes')
      .select('id, nome, telefone, cpf_cnpj, mesclado_em')
      .eq('empresa_id', empresaId).eq('cpf_cnpj', doc).limit(1);
    if (data?.length) return _seguirMesclado(data[0]);
  }

  // Traz a lista da empresa e compara aqui. Filtrar por `ilike` no nome
  // seria mais econômico, mas erra justamente onde não pode errar: o
  // acento. "Thainá" com ilike 'Thainá%' não acha a linha gravada como
  // "THAINA", e um cadastro a mais nasce por causa de um til. A tabela de
  // clientes da loja tem centenas de linhas, não milhares, e isto só roda
  // quando um cliente vai ser criado.
  const { data } = await supabase.from('clientes')
    .select('id, nome, telefone, cpf_cnpj, mesclado_em')
    .eq('empresa_id', empresaId)
    .limit(5000);
  const achado = (data || []).find(c => _mesmoCliente(cliente, c));
  return achado ? _seguirMesclado(achado) : null;
}

async function _seguirMesclado(cliente, saltos = 0) {
  if (!cliente?.mesclado_em || saltos >= 10) return cliente;
  const { data } = await supabase.from('clientes')
    .select('id, nome, telefone, cpf_cnpj, mesclado_em')
    .eq('id', cliente.mesclado_em).limit(1);
  if (!data?.length) return cliente;
  return _seguirMesclado(data[0], saltos + 1);
}

// Era um INSERT cego, e é daí que vinham as cópias no sistema web: quatro
// caminhos diferentes chamam esta função (fila de sync, recuperação de
// clientes sem remote_id, venda que sobe antes do cliente, e o resolver
// de venda), e nenhum perguntava se o cliente já estava lá. Bastava um
// terminal limpar o remote_id local — o que a própria correção de ids
// legados do Base44 faz de propósito — pra loja inteira ser recadastrada
// do zero. Foi assim nos dois surtos: 8 cópias em 07/08 e 33 em 24/08,
// todas no mesmo minuto.
//
// Agora resolve antes de criar e é idempotente: chamar dez vezes para o
// mesmo cliente devolve sempre o mesmo id. Completa o cadastro achado com
// o que o local tem e o remoto não (telefone que faltava, CPF, e-mail) em
// vez de descartar — era esse "vazio de um lado" que fazia o par parecer
// gente diferente na próxima rodada.
async function registrarCliente(cliente, empresaIdHint = null) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = empresaIdHint || usuario.empresa_estoque_id || usuario.empresa_id;

  const existente = await _acharClienteRemoto(cliente, empresaId);
  if (existente) {
    const completar = {};
    if (!_soDigitos(existente.telefone) && cliente.telefone) completar.telefone = cliente.telefone;
    if (!_soDigitos(existente.cpf_cnpj) && cliente.cpf_cnpj) completar.cpf_cnpj = cliente.cpf_cnpj;
    if (Object.keys(completar).length) {
      const { data } = await supabase.from('clientes').update(completar).eq('id', existente.id).select().single();
      if (data) return data;
    }
    console.log(`[API] Cliente "${cliente.nome}" já existia no Supabase (${existente.id}) — reaproveitado em vez de duplicar`);
    const { data } = await supabase.from('clientes').select('*').eq('id', existente.id).single();
    return data || existente;
  }

  const { data, error } = await supabase.from('clientes').insert({
    empresa_id: empresaId,
    nome: cliente.nome,
    cpf_cnpj: cliente.cpf_cnpj || null,
    telefone: cliente.telefone || null,
    email: cliente.email || null,
    limite_credito: cliente.limite_credito || 0,
    saldo_credito: cliente.saldo_credito || 0,
    ativo: true,
  }).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function atualizarCliente(remoteId, dados) {
  const { data, error } = await supabase.from('clientes').update(dados).eq('id', remoteId).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function atualizarClienteEndereco(remoteId, dados) {
  const payload = {};
  const campos = ['telefone', 'whatsapp', 'cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'estado', 'referencia', 'obs_entrega'];
  campos.forEach(c => { if (dados[c]) payload[c] = dados[c]; });
  if (!Object.keys(payload).length) return null;
  const { data, error } = await supabase.from('clientes').update(payload).eq('id', remoteId).select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function sincronizarClientes(ultimaSync = null) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  const pageSize = 500;
  let from = 0;
  const clientes = [];

  while (true) {
    let query = supabase.from('clientes').select('*').eq('ativo', true).range(from, from + pageSize - 1).order('nome').order('id');
    if (empresaId && !usuario.unificar_estoque) query = query.eq('empresa_id', empresaId);
    if (ultimaSync) query = query.gte('updated_at', ultimaSync);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const items = data || [];
    clientes.push(...items);
    if (items.length < pageSize) break;
    from += pageSize;
  }
  return clientes;
}

// ─── Contas a Receber / Créditos de Cliente ───────────────────────────

const STATUS_CONTA_REMOTO_PARA_LOCAL = { aberto: 'pendente', parcial: 'pendente', vencido: 'pendente', recebido: 'pago', cancelado: 'cancelado', renegociado: 'cancelado' };
const STATUS_CREDITO_REMOTO_PARA_LOCAL = { disponivel: 'aberto', parcial: 'usado_parcialmente', utilizado: 'usado_totalmente', cancelado: 'cancelado', expirado: 'usado_totalmente' };
const STATUS_CREDITO_LOCAL_PARA_REMOTO = { aberto: 'disponivel', usado_parcialmente: 'parcial', usado_totalmente: 'utilizado' };

// Cadastros que o sistema web unificou. `sincronizarClientes` só traz os
// ativos, então um cadastro que virou cópia some do sync e o terminal fica
// com o remote_id de um cliente morto para sempre — sem erro, só sem
// atualização nunca mais. Aqui vem só a lista de "quem virou quem", que é
// pequena, para o PDV seguir a unificação em vez de ignorá-la.
async function sincronizarClientesMesclados() {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  let query = supabase.from('clientes').select('id, mesclado_em').not('mesclado_em', 'is', null);
  if (empresaId && !usuario.unificar_estoque) query = query.eq('empresa_id', empresaId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

async function sincronizarContasReceber() {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  let query = supabase.from('contas_receber').select('*').in('status', ['aberto', 'parcial', 'vencido']);
  if (empresaId) query = query.eq('empresa_id', empresaId);
  const { data, error } = await query;
  if (error) { console.warn('[ContasReceber]', error.message); return []; }
  return (data || []).map(c => ({
    id: c.id,
    empresa_id: c.empresa_id,
    cliente_id: c.cliente_id,
    cliente_nome: c.cliente_nome,
    valor: c.valor_aberto,
    descricao: c.numero_doc || c.origem,
    origem: c.origem,
    status: STATUS_CONTA_REMOTO_PARA_LOCAL[c.status] || 'pendente',
    vencimento: c.data_vencimento,
    data_pagamento: null,
    forma_recebimento: c.forma_prevista,
    referencia: c.numero_doc,
    observacao: c.observacao,
    created_date: c.created_at,
    updated_date: c.updated_at,
  }));
}

async function pagarContaReceber(contaId, formaPagamento, observacao) {
  const { data: conta } = await supabase.from('contas_receber').select('valor_original, empresa_id, cliente_id').eq('id', contaId).single();
  if (!conta) throw new Error('Conta a receber não encontrada');
  const { error } = await supabase.from('contas_receber').update({ valor_recebido: conta.valor_original, status: 'recebido', forma_prevista: formaPagamento || 'dinheiro', observacao: observacao || null }).eq('id', contaId);
  if (error) throw new Error(error.message);
  await supabase.from('recebimentos').insert({
    empresa_id: conta.empresa_id, conta_id: contaId, cliente_id: conta.cliente_id,
    valor: conta.valor_original, valor_liquido: conta.valor_original,
    forma_pagamento: formaPagamento || 'dinheiro', observacao: observacao || null,
  });
  return { ok: true };
}

async function pagarContaReceberParcial(contaId, valorPago, valorOriginal, formaPagamento, observacao) {
  const { data: conta } = await supabase.from('contas_receber').select('valor_recebido, empresa_id, cliente_id').eq('id', contaId).single();
  if (!conta) throw new Error('Conta a receber não encontrada');
  const novoRecebido = Number(conta.valor_recebido || 0) + valorPago;
  const quitou = novoRecebido >= valorOriginal;
  const { error } = await supabase.from('contas_receber').update({
    valor_recebido: novoRecebido,
    status: quitou ? 'recebido' : 'parcial',
    observacao: `Pgto parcial R$ ${valorPago.toFixed(2)} (${formaPagamento || 'dinheiro'})${observacao ? ' — ' + observacao : ''}`,
  }).eq('id', contaId);
  if (error) throw new Error(error.message);
  await supabase.from('recebimentos').insert({
    empresa_id: conta.empresa_id, conta_id: contaId, cliente_id: conta.cliente_id,
    valor: valorPago, valor_liquido: valorPago,
    forma_pagamento: formaPagamento || 'dinheiro', observacao: observacao || null,
  });
  return { ok: true };
}

async function getCreditosDoCliente(clienteRemoteId) {
  const { data, error } = await supabase.from('creditos_cliente').select('*').eq('cliente_id', clienteRemoteId).in('status', ['disponivel', 'parcial']).order('created_at');
  if (error) { console.warn('[Creditos]', error.message); return []; }
  return (data || []).map(c => ({
    id: c.id, cliente_id: c.cliente_id, valor_original: c.valor_original,
    saldo_atual: c.saldo_disponivel, status: STATUS_CREDITO_REMOTO_PARA_LOCAL[c.status] || 'aberto',
    observacao: c.observacao, created_date: c.created_at,
  }));
}

async function sincronizarCreditosCliente() {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  let query = supabase.from('creditos_cliente').select('*').in('status', ['disponivel', 'parcial']);
  if (empresaId) query = query.eq('empresa_id', empresaId);
  const { data, error } = await query;
  if (error) { console.warn('[CreditosCliente]', error.message); return []; }
  return (data || []).map(c => ({
    id: c.id, empresa_id: c.empresa_id, cliente_id: c.cliente_id, cliente_nome: null, cliente_telefone: null,
    valor_original: c.valor_original, saldo_atual: c.saldo_disponivel,
    status: STATUS_CREDITO_REMOTO_PARA_LOCAL[c.status] || 'aberto',
    origem: c.origem, observacao: c.observacao, created_date: c.created_at, updated_date: c.updated_at,
  }));
}

async function receberCreditoCliente(remoteId, saldoNovo, novoStatus, observacao) {
  const { data: credito } = await supabase.from('creditos_cliente').select('valor_original').eq('id', remoteId).single();
  if (!credito) throw new Error('Crédito não encontrado');
  const valorUtilizado = Number(credito.valor_original || 0) - Number(saldoNovo || 0);
  const { error } = await supabase.from('creditos_cliente').update({
    valor_utilizado: valorUtilizado,
    status: STATUS_CREDITO_LOCAL_PARA_REMOTO[novoStatus] || 'parcial',
    observacao: observacao || null,
  }).eq('id', remoteId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

async function criarCreditoCliente(payload) {
  const { data, error } = await supabase.from('creditos_cliente').insert({
    empresa_id: payload.empresa_id,
    cliente_id: payload.cliente_id,
    valor_original: payload.valor_original,
    valor_utilizado: 0,
    origem: payload.origem || 'devolucao',
    descricao: payload.observacao || null,
    observacao: payload.observacao || null,
    operador_nome: payload.operador_nome || null,
    status: 'disponivel',
  }).select().single();
  if (error) throw new Error(error.message);
  return { id: data.id };
}

async function usarCreditoEmConta(contaId, contaValor, creditoId, creditoSaldoAtual, formaPagamento, observacao) {
  const [{ data: conta }, { data: credito }] = await Promise.all([
    supabase.from('contas_receber').select('valor_original, valor_recebido, empresa_id, cliente_id').eq('id', contaId).single(),
    supabase.from('creditos_cliente').select('valor_original, valor_utilizado').eq('id', creditoId).single(),
  ]);
  if (!conta || !credito) throw new Error('Conta ou crédito não encontrado');

  if (creditoSaldoAtual >= contaValor) {
    await supabase.from('contas_receber').update({ valor_recebido: conta.valor_original, status: 'recebido', observacao: observacao || 'Pago com crédito loja' }).eq('id', contaId);
    const novoUtilizado = Number(credito.valor_utilizado || 0) + contaValor;
    await supabase.from('creditos_cliente').update({ valor_utilizado: novoUtilizado, status: novoUtilizado >= credito.valor_original ? 'utilizado' : 'parcial' }).eq('id', creditoId);
    await supabase.from('credito_utilizacoes').insert({ empresa_id: conta.empresa_id, credito_id: creditoId, cliente_id: conta.cliente_id, conta_id: contaId, valor: contaValor, descricao: observacao || null });
    const novoSaldo = Math.round((creditoSaldoAtual - contaValor) * 100) / 100;
    return { quitou: true, saldoCreditoRestante: novoSaldo };
  } else {
    const novoRecebido = Number(conta.valor_recebido || 0) + creditoSaldoAtual;
    const valorRestante = Math.round((contaValor - creditoSaldoAtual) * 100) / 100;
    await supabase.from('contas_receber').update({ valor_recebido: novoRecebido, observacao: `Crédito loja R$ ${creditoSaldoAtual.toFixed(2)} aplicado` }).eq('id', contaId);
    await supabase.from('creditos_cliente').update({ valor_utilizado: credito.valor_original, status: 'utilizado' }).eq('id', creditoId);
    await supabase.from('credito_utilizacoes').insert({ empresa_id: conta.empresa_id, credito_id: creditoId, cliente_id: conta.cliente_id, conta_id: contaId, valor: creditoSaldoAtual, descricao: observacao || null });
    return { quitou: false, saldoCreditoRestante: 0, valorRestante };
  }
}

// ─── Faltas ───────────────────────────────────────────────────────────

// PRIMEIRA OPERACAO DE NEGOCIO COM ROTA AUTENTICADA.
//
// O `falta.id` local ja existe: `db.faltas.registrar()` o gera e grava no
// SQLite ANTES de qualquer envio. Ele e a chave de idempotencia natural —
// sobrevive a queda, timeout, fechamento, reinicio e replay, porque nasce em
// disco e nao em memoria.
//
// O legado abaixo gera um uuid NOVO a cada envio, e e por isso que uma
// resposta perdida vira linha duplicada: o `remote_id` nunca chega, o guard
// `!falta.remote_id` nao protege, e o retry insere de novo.
//
// SOBRE O FALLBACK, e a diferenca em relacao a `impressao`:
//
// Aqui o caminho antigo FUNCIONA. Cair nele em silencio seria gravar sem
// autenticacao toda vez que a rota nova tivesse um solucco — e, pior, poderia
// duplicar justamente no caso de resposta perdida. Entao:
//
//   sem_identidade / rota_desligada  -> legado, sem alarde (rollout normal)
//   timeout / rede / 5xx             -> NAO cai no legado. Deixa na fila.
//   qualquer outra recusa            -> NAO cai no legado. Registra e para.
//
// A ambiguidade do timeout e o motivo. Se o servidor gravou e a resposta se
// perdeu, tentar o legado criaria a segunda linha. O certo e reenviar pela
// MESMA rota com a MESMA chave — o servidor devolve o resultado ja
// processado. Isso e o retry da fila, e ele ja acontece sozinho.
async function registrarFalta(falta) {
  const terminal = require('./terminal');

  // A chave e o id local. Sem ele nao ha idempotencia possivel, e ai o unico
  // caminho honesto e o legado.
  if (falta.id) {
    const r = await terminal.chamarProtegida('/api/pdv/faltas', {
      idempotency_key: falta.id,
      produto_id: _comoUuid(falta.produto_remote_id),
      produto_nome: falta.produto_nome,
      produto_sku: falta.produto_sku || null,
      cliente_nome: falta.cliente_nome || null,
      cliente_telefone: falta.cliente_telefone || null,
      quantidade_solicitada: falta.quantidade_solicitada || 1,
      observacao: falta.observacao || null,
      status: falta.status || 'pendente',
      origem: falta.origem || 'pdv',
      usuario_nome: falta.usuario_nome || (store.get('auth.usuario') || {}).nome || null,
      tipo: falta.tipo === 'encomenda' ? 'encomenda' : 'falta',
      prazo_desejado: falta.prazo_desejado || null,
      preco_negociado: falta.preco_negociado != null ? Number(falta.preco_negociado) : null,
      terminal_id: store.get('config.terminal_id') || null,
      versao_pdv: app_getVersion(),
    });

    if (r.ok) {
      console.log(`[FALTA] Registrada pela rota autenticada${r.dados.repetido || r.dados.ja_existia ? ' (ja existia)' : ''}`);
      return { id: r.dados.falta_id };
    }

    const rolloutNormal = ['sem_identidade', 'rota_desligada'];
    if (!rolloutNormal.includes(r.motivo)) {
      // Nao cai no legado. Lanca para a fila tentar de novo com a MESMA
      // chave, que e a unica forma segura de sair de um timeout ambiguo.
      throw new Error(`Rota autenticada de faltas recusou (${r.motivo}): ${r.erro}`);
    }
    // Chegou aqui: este terminal ainda nao foi migrado. Segue o legado, e o
    // servidor fica sabendo — ver `registrarFallbackFalta` no fim do arquivo.
    terminal.registrarFallback('faltas.registrar', falta.id, r.motivo).catch(() => {});
  }

  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  const id = uuidv4();
  const { error } = await supabase.from('faltas').insert({
    id,
    empresa_id: empresaId,
    produto_id: _comoUuid(falta.produto_remote_id),
    produto_nome: falta.produto_nome,
    produto_sku: falta.produto_sku || null,
    cliente_nome: falta.cliente_nome || null,
    cliente_telefone: falta.cliente_telefone || null,
    quantidade_solicitada: falta.quantidade_solicitada || 1,
    observacao: falta.observacao || null,
    status: falta.status || 'pendente',
    origem: falta.origem || 'pdv',
    // Quem anotou. Ficava sempre nulo porque nenhuma das duas telas mandava
    // o operador — e sem isso o comprador não tem a quem perguntar se o
    // cliente ainda quer o produto. O nome do operador logado já está no
    // store; é só usá-lo quando a tela não informar outro.
    usuario_nome: falta.usuario_nome || usuario.nome || null,
    tipo: falta.tipo === 'encomenda' ? 'encomenda' : 'falta',
    prazo_desejado: falta.prazo_desejado || null,
    preco_negociado: falta.preco_negociado != null ? Number(falta.preco_negociado) : null,
    terminal_id: falta.terminal_id || store.get('config.terminal_id') || null,
  });
  if (error) throw new Error(error.message);
  return { id };
}

async function atualizarFalta(remoteId, dados) {
  const { error } = await supabase.from('faltas').update(dados).eq('id', remoteId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

// Status que ainda interessam ao balcão. `recebido` é o mais importante da
// lista: é o momento em que o vendedor pode ligar para o cliente avisando
// que a encomenda chegou. Enquanto o filtro trazia só pendente/notificado/
// comprado, o painel podia marcar "recebido" à vontade — a informação
// morria no servidor e nunca chegava a quem atende.
const STATUS_ABERTOS = [
  'pendente', 'em_analise', 'em_compra', 'pedido', 'recebido',
  'notificado', 'comprado', // vocabulário antigo, ainda em linhas existentes
];

async function listarFaltasRemoto() {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  let query = supabase.from('faltas').select('*').in('status', STATUS_ABERTOS).order('created_at', { ascending: false }).limit(200);
  if (empresaId) query = query.eq('empresa_id', empresaId);
  const { data, error } = await query;
  if (error) { console.warn('[Faltas]', error.message); return []; }
  return (data || []).map(f => ({ ...f, created_date: f.created_at }));
}

// ─── Orçamentos ─────────────────────────────────────────────────────
// Schema real confirmado em pdv-vargas-web/src/components/pdv/PDVClient.tsx
// (salvarOrcamento): orcamentos tem só empresa_id, cliente_id, cliente_nome,
// operador_nome, status, subtotal, desconto, total, observacao, validade —
// sem forma_pagamento/terminal_id/origem (campos do Base44 que não existem
// aqui). numero é atribuído pelo Supabase, não é enviado no insert.

function _validadeIso(validadeDias) {
  if (!validadeDias) return null;
  const d = new Date(Date.now() + validadeDias * 86400000);
  return d.toISOString().slice(0, 10);
}

// ORCAMENTO COMO COMANDO UNICO — a rota nova.
//
// Devolve um resultado RICO de proposito, porque quem chama precisa distinguir
// coisas que o caminho antigo tratava igual:
//
//   ok        gravou; `revisao` e a nova confirmada, para guardar localmente
//   conflito  409 — NAO repetir. O cliente partiu de um estado velho e
//             precisa recarregar. Repetir automaticamente aqui seria laco
//             infinito, e cair no legado seria sobrescrever a edicao de outro.
//   legado    este terminal ainda nao foi migrado
//   erro      transitorio; a fila tenta de novo com a MESMA chave
//
// A chave (`<id>:r<revisao_base>`) e montada no SERVIDOR a partir do corpo, e
// nao aqui — o cliente nao escolhe a identidade da propria tentativa.
async function salvarOrcamentoAutenticado(cmd) {
  const terminal = require('./terminal');
  const orc = cmd.orc || {};
  const r = await terminal.chamarProtegida('/api/pdv/orcamentos', {
    // Identidade EFETIVA: `remote_id ?? id_local`. Decidida pelo orquestrador,
    // nao aqui — o transporte nao escolhe identidade.
    orcamento_id: cmd.orcamento_id,
    revisao_base: cmd.revisao_base,
    idempotency_key: cmd.idempotency_key,
    acao: cmd.acao,
    cabecalho: {
      cliente_nome: orc.cliente_nome || null,
      operador_nome: orc.vendedor_nome || null,
      // Mesmo mapeamento de sync.js: 'pendente' local e 'aberto' remoto.
      status: cmd.acao === 'cancelar' ? 'cancelado'
            : (orc.status === 'pendente' ? 'aberto' : orc.status),
      subtotal: orc.subtotal, desconto: orc.desconto, total: orc.total,
      observacao: orc.observacao || null,
      validade: _validadeIso(orc.validade_dias),
    },
    itens: (cmd.itens || []).map(i => ({
      produto_remote_id: i.produto_remote_id, produto_id: i.produto_id,
      produto_nome: i.produto_nome, produto_sku: i.produto_sku || null,
      quantidade: i.quantidade, preco_unitario: i.preco_unitario,
      desconto: i.desconto || 0, total: i.total != null ? i.total : i.subtotal,
    })),
    versao_pdv: app_getVersion(),
  });

  if (r.ok) return { tipo: 'ok', dados: r.dados };
  if (r.motivo === 'sem_identidade' || r.motivo === 'rota_desligada') {
    return { tipo: 'legado', motivo: r.motivo };
  }
  if (r.motivo === 'conflito_versao' || String(r.erro || '').includes('conflito')) {
    return { tipo: 'conflito', erro: r.erro };
  }
  return { tipo: 'erro', erro: r.erro, motivo: r.motivo };
}

// FASE 0.6C.5 — snapshot de um orcamento que este terminal NAO mantem.
//
// Uma leitura, um estado logico: cabecalho, itens e revisao saem da mesma
// instrucao SQL na RPC. `getOrcamentoCloud` (abaixo) faz duas consultas
// separadas e continua existindo so como fallback para terminal sem a flag.
//
// A `revisao` devolvida aqui e o que vira `revisao_base` na gravacao seguinte.
// A RPC fala a lingua do servidor (`orcamento_id`, `validade` como data). A
// tela fala a do SQLite (`id`, `validade_dias`). A traducao mora aqui, num
// lugar so — e `revisao` vem junto, porque e ela que vira `revisao_base` na
// gravacao seguinte.
function _snapshotParaTela(s) {
  const criado = s.created_at ? new Date(s.created_at) : null;
  const validade = s.validade ? new Date(s.validade) : null;
  const dias = criado && validade
    ? Math.max(1, Math.round((validade - criado) / 86400000))
    : 7;
  return {
    id: s.orcamento_id,
    remote_id: s.orcamento_id,
    numero: s.numero,
    status: s.status,
    revisao: s.revisao,
    empresa_id: s.empresa_id,
    terminal_id: s.terminal_id,
    cliente_id: s.cliente_id || null,
    cliente_nome: s.cliente_nome || null,
    cliente_telefone: null,
    vendedor_nome: s.operador_nome || null,
    forma_pagamento: null,
    validade_dias: dias,
    subtotal: Number(s.subtotal || 0),
    desconto: Number(s.desconto || 0),
    total: Number(s.total || 0),
    observacao: s.observacao || null,
    created_at: s.created_at,
    itens: (s.itens || []).map((i) => ({
      produto_id: i.produto_id, produto_nome: i.produto_nome, produto_sku: i.produto_sku,
      quantidade: Number(i.quantidade || 0), preco_unitario: Number(i.preco_unitario || 0),
      desconto: Number(i.desconto || 0), total: Number(i.total || 0),
    })),
  };
}

async function lerOrcamentoAutenticado(orcamentoId) {
  const terminal = require('./terminal');
  const r = await terminal.chamarProtegida(
    `/api/pdv/orcamentos/${encodeURIComponent(orcamentoId)}`, null, { metodo: 'GET' });

  if (r.ok) return { tipo: 'ok', dados: _snapshotParaTela(r.dados) };
  if (r.motivo === 'sem_identidade' || r.motivo === 'rota_desligada') {
    return { tipo: 'legado', motivo: r.motivo };
  }
  // Offline e um desfecho proprio: a tela precisa dizer "sem conexao", nunca
  // "nao encontrado".
  if (r.motivo === 'rede' || r.motivo === 'url_redireciona') {
    return { tipo: 'offline', erro: r.erro };
  }
  if (r.status === 404 || r.corpo?.estado === 'nao_encontrado') {
    return { tipo: 'nao_encontrado' };
  }
  return { tipo: 'erro', motivo: r.motivo, erro: r.erro };
}

// FASE 0.6C.6A — a conversao pela rota autenticada.
//
// Substitui `atualizarStatusOrcamento(remote_id, 'convertido')`, que era
// escrita pelo `anon`, fora do orcamentoComando, sem telemetria e com o erro
// engolido. Aqui todo desfecho tem nome, e o conflito devolve QUEM ganhou.
async function converterOrcamentoAutenticado({ orcamento_id, venda_id, revisao_base }) {
  const terminal = require('./terminal');
  const r = await terminal.chamarProtegida('/api/pdv/orcamentos/converter', {
    orcamento_id, venda_id, revisao_base,
    versao_pdv: app_getVersion(),
  });

  if (r.ok) {
    const estado = r.dados?.estado;
    // 'convertido' e 'ja_convertido' sao os dois sucessos. O segundo e o retry
    // da MESMA venda, e precisa ser sucesso — senao a fila insistiria para
    // sempre numa operacao que ja aconteceu.
    return { tipo: 'ok', estado, dados: r.dados };
  }
  if (r.motivo === 'sem_identidade' || r.motivo === 'rota_desligada') {
    return { tipo: 'legado', motivo: r.motivo };
  }
  const estado = r.corpo?.estado;
  if (estado === 'conflito_conversao') {
    return { tipo: 'conflito_conversao', dados: r.corpo };
  }
  if (estado === 'conflito_versao' || estado === 'recusado_cancelado' || estado === 'nao_encontrado') {
    return { tipo: 'recusado', estado, dados: r.corpo };
  }
  return { tipo: 'erro', motivo: r.motivo, erro: r.erro };
}

async function sincronizarOrcamento(payload) {
  const { data: orc, error } = await supabase.from('orcamentos').insert({
    empresa_id: payload.empresa_id,
    cliente_nome: payload.cliente_nome || null,
    operador_nome: payload.vendedor_nome || null,
    status: 'aberto',
    subtotal: payload.subtotal,
    desconto: payload.desconto_total || payload.desconto || 0,
    total: payload.total,
    observacao: payload.observacao || null,
    validade: _validadeIso(payload.validade_dias),
  }).select().single();
  if (error) throw new Error(error.message);

  const itens = payload.itens || [];
  if (itens.length) {
    const { error: errItens } = await supabase.from('orcamento_itens').insert(itens.map(i => ({
      orcamento_id: orc.id,
      produto_id: _comoUuid(i.produto_id),
      produto_nome: i.produto_nome,
      produto_sku: i.produto_sku || null,
      quantidade: i.quantidade,
      preco_unitario: i.preco_unitario,
      desconto: i.desconto || 0,
      total: i.subtotal ?? i.total,
    })));
    if (errItens) console.warn('[ORC] Erro ao inserir orcamento_itens:', errItens.message);
  }

  return { id: orc.id, numero: orc.numero };
}

async function atualizarStatusOrcamento(remoteId, status) {
  const { error } = await supabase.from('orcamentos').update({ status }).eq('id', remoteId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

async function atualizarOrcamento(remoteId, dados) {
  const payload = {};
  if (dados.cliente_nome !== undefined) payload.cliente_nome = dados.cliente_nome;
  if (dados.subtotal !== undefined) payload.subtotal = dados.subtotal;
  if (dados.desconto !== undefined) payload.desconto = dados.desconto;
  if (dados.total !== undefined) payload.total = dados.total;
  if (dados.observacao !== undefined) payload.observacao = dados.observacao;
  if (dados.validade_dias !== undefined) payload.validade = _validadeIso(dados.validade_dias);
  const { error } = await supabase.from('orcamentos').update(payload).eq('id', remoteId);
  if (error) throw new Error(error.message);

  if (dados.itens) {
    await supabase.from('orcamento_itens').delete().eq('orcamento_id', remoteId);
    if (dados.itens.length) {
      await supabase.from('orcamento_itens').insert(dados.itens.map(i => ({
        orcamento_id: remoteId,
        // Nunca cair pra i.produto_id (id local) — mesmo risco de item
        // órfão já corrigido em vendas; aqui tinha ficado pra trás.
        produto_id: _comoUuid(i.produto_remote_id),
        produto_nome: i.produto_nome,
        produto_sku: i.produto_sku || null,
        quantidade: i.quantidade,
        preco_unitario: i.preco_unitario,
        desconto: i.desconto || 0,
        total: i.total,
      })));
    }
  }
  return { ok: true };
}

function _mapOrcamentoRemoto(o) {
  return {
    id: o.id,
    remote_id: o.id,
    numero: o.numero,
    status: o.status || 'aberto',
    cliente_id: o.cliente_id || null,
    cliente_nome: o.cliente_nome || null,
    cliente_telefone: null,
    vendedor_nome: o.operador_nome || null,
    forma_pagamento: null,
    validade_dias: null,
    subtotal: o.subtotal || 0,
    desconto: o.desconto || 0,
    total: o.total || 0,
    observacao: o.observacao || null,
    created_at: o.created_at,
  };
}

// Baixa orçamentos de todos os terminais pro cache local (cabeçalho só —
// os itens ficam disponíveis via getOrcamentoCloud/listarOrcamentosCloud).
async function sincronizarOrcamentos() {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  let query = supabase.from('orcamentos').select('*').in('status', ['aberto']).order('created_at', { ascending: false }).limit(200);
  if (empresaId) query = query.eq('empresa_id', empresaId);
  const { data, error } = await query;
  if (error) { console.warn('[Orcamentos]', error.message); return []; }
  return (data || []).map(_mapOrcamentoRemoto);
}

// FASE 0.6C.4 — quais dos documentos QUE ESTE TERMINAL CONHECE o servidor ja
// cancelou.
//
// Perguntar so pelas identidades locais, em vez de baixar todo cancelado que
// existe, tem tres consequencias boas: o custo fica limitado pela tabela local
// e nao cresce com o historico; nao volta tombstone que teria de ser
// descartado (cancelamento NAO cria documento); e a descida A, validada na
// 0.6C.3, nao e tocada.
//
// O filtro de UUID nao e decorativo: este terminal tem um resquicio Base44
// com `remote_id = '6a481d1dc98da82e12921a85'`, e mandar isso para uma coluna
// uuid derruba a consulta INTEIRA com 22P02 — medido. Um id de outra era nao
// pode cegar a sincronizacao dos demais.
const _UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function orcamentosCanceladosNoServidor(identidades) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  const uuids = [...new Set((identidades || []).filter((x) => _UUID.test(String(x))))];
  const achados = [];
  // Em lotes: 200 uuids numa querystring passariam de 7 KB.
  for (let i = 0; i < uuids.length; i += 100) {
    let query = supabase.from('orcamentos')
      .select('id, numero, status')
      .eq('status', 'cancelado')
      .in('id', uuids.slice(i, i + 100));
    if (empresaId) query = query.eq('empresa_id', empresaId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    achados.push(...(data || []));
  }
  return achados;
}

async function listarOrcamentosCloud(filtros = {}) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  let query = supabase.from('orcamentos').select('*').order('created_at', { ascending: false }).limit(500);
  if (empresaId) query = query.eq('empresa_id', empresaId);
  if (filtros?.status) query = query.eq('status', filtros.status);
  const { data, error } = await query;
  if (error) { console.warn('[Orcamentos]', error.message); return []; }
  return (data || []).map(o => ({ ..._mapOrcamentoRemoto(o), _origem: 'cloud' }));
}

async function getOrcamentoCloud(remoteId) {
  const { data: o, error } = await supabase.from('orcamentos').select('*').eq('id', remoteId).single();
  if (error || !o) return null;
  const { data: itens } = await supabase.from('orcamento_itens').select('*').eq('orcamento_id', remoteId);
  return {
    ..._mapOrcamentoRemoto(o),
    itens: (itens || []).map(i => ({
      produto_nome: i.produto_nome || '',
      quantidade: i.quantidade || 1,
      preco_unitario: i.preco_unitario || 0,
      desconto: i.desconto || 0,
      total: i.total || 0,
    })),
  };
}

// ─── Config (desconto / termômetro) ────────────────────────────────────

async function sincronizarConfigDesconto() {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  let query = supabase.from('config_desconto').select('*');
  if (empresaId) query = query.eq('empresa_id', empresaId);
  const { data, error } = await query;
  if (error) { console.warn('[ConfigDesconto]', error.message); return []; }
  return data || [];
}

// Config de Saúde da Venda (taxas, faixas de margem e a regra de
// "promoção só vale à vista" — orcamento_promo_formas). Um registro por
// empresa (saude_config.empresa_id, UNIQUE). Era um stub que sempre
// devolvia null; o terminal nunca puxava essa config de verdade.
async function sincronizarConfigTermometro() {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  if (!empresaId) return null;
  const { data, error } = await supabase.from('saude_config').select('*').eq('empresa_id', empresaId).maybeSingle();
  if (error) { console.warn('[ConfigTermometro]', error.message); return null; }
  return data;
}

// ─── Endereçamento de estoque (onde o produto está no depósito) ───────
// Módulo opt-in por depósito (deposito_enderecamento_config.modo) — se
// nunca foi ligado, não existe endereço nenhum e isso devolve lista vazia
// silenciosamente (não é erro, é o estado padrão da maioria dos depósitos).
// Só traz o endereço do DEPÓSITO do terminal (do operador, senão o
// principal da empresa) — o mesmo raciocínio de _resolverDepositoAjuste,
// porque o vendedor só precisa achar o produto onde ELE está, não em
// todos os depósitos da empresa.
async function sincronizarEnderecosProdutos() {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  if (!empresaId) return [];
  const depositoId = await _resolverDepositoAjuste(null, empresaId);
  if (!depositoId) return [];

  const { data: config } = await supabase.from('deposito_enderecamento_config')
    .select('modo').eq('deposito_id', depositoId).maybeSingle();
  if (!config || config.modo === 'desativado') return [];

  const { data, error } = await supabase.from('produto_enderecos')
    .select('produto_id, quantidade, papel, enderecos!inner(codigo_legivel, status)')
    .eq('empresa_id', empresaId).eq('deposito_id', depositoId)
    .eq('enderecos.status', 'ativo').gt('quantidade', 0);
  if (error) { console.warn('[Enderecos]', error.message); return []; }

  // Um produto pode estar em vários endereços — prioriza o marcado como
  // "picking" (separação/venda); sem isso, o de maior quantidade.
  const porProduto = new Map();
  for (const row of data || []) {
    const atual = porProduto.get(row.produto_id);
    const candidato = { codigo_legivel: row.enderecos.codigo_legivel, papel: row.papel, quantidade: row.quantidade };
    const substitui = !atual
      || (candidato.papel === 'picking' && atual.papel !== 'picking')
      || (candidato.papel === atual.papel && candidato.quantidade > atual.quantidade);
    if (substitui) porProduto.set(row.produto_id, candidato);
  }
  return Array.from(porProduto, ([produto_id, v]) => ({ produto_id, codigo_legivel: v.codigo_legivel }));
}

// ─── WhatsApp (envio de orçamento/pedido/cupom via Z-API) ─────────────
// O terminal só tem a chave anônima — não pode ler whatsapp_config (guarda
// o token do Z-API) nem chamar a rota /api/whatsapp/enviar do painel (exige
// sessão de navegador). Passa pela Edge Function enviar-whatsapp-pdv, que
// roda com privilégio elevado só no servidor e nunca devolve o token pro
// cliente. Ver pdv-vargas-web/supabase/functions/enviar-whatsapp-pdv.
async function chamarPdvProxy(_action, params) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  if (!empresaId) throw new Error('Empresa não identificada — faça login novamente');

  const url = `${supabase.supabaseUrl}/functions/v1/enviar-whatsapp-pdv`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabase.supabaseKey,
      Authorization: `Bearer ${supabase.supabaseKey}`,
    },
    body: JSON.stringify({ ...params, empresa_id: empresaId, operador_nome: usuario.nome || null }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Servidor retornou resposta inválida: ${text.slice(0, 200)}`); }
  if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

// ─── Impressão em rede (URL do tunnel do terminal-caixa) ──────────────

// A PRIMEIRA ESCRITA QUE TENTA A ROTA PROTEGIDA.
//
// Ordem: rota autenticada primeiro; caminho antigo só quando este terminal
// ainda não tem identidade ou ainda não foi liberado no rollout.
//
// ── SOBRE O FALLBACK ─────────────────────────────────────────────────────
//
// Voltar ao caminho antigo aqui é seguro, e é seguro por um motivo específico
// que NÃO vale para venda: o caminho antigo desta operação já não funciona. O
// `anon` perdeu INSERT e UPDATE em `pdv_impressao` numa onda de fechamento de
// privilégios, então o upsert abaixo falha sempre. O "fallback" é, na prática,
// continuar sem publicar — que é o estado de hoje. Não há duplicidade
// possível, não há inconsistência a criar, e nada de segurança se perde.
//
// Quando `vendas` migrar, este raciocínio não se repete: lá o caminho antigo
// FUNCIONA, e cair nele em silêncio depois de a rota nova falhar significaria
// gravar venda sem autenticação sempre que a API tivesse um soluço. A
// estratégia lá é fila offline com idempotência e replay autenticado, nunca
// escrita direta como plano B.
async function atualizarUrlImpressao(url) {
  const terminal = require('./terminal');

  const r = await terminal.chamarProtegida('/api/pdv/impressao', {
    print_server_url: url,
    // Mesma URL, mesma chave: republicar a mesma coisa não é operação nova.
    // Túnel novo gera URL nova, e aí a chave muda sozinha.
    idempotency_key: terminal.chaveDe('impressao', url),
  });

  if (r.ok) {
    console.log('[IMPRESSAO] URL publicada pela rota autenticada' + (r.dados.repetido ? ' (repetida)' : ''));
    return;
  }

  // Recusa esperada durante o rollout não é erro — é "ainda não é a vez deste
  // terminal". Só elas caem no caminho antigo sem alarde.
  const esperado = ['sem_identidade', 'rota_desligada'];
  if (!esperado.includes(r.motivo)) {
    console.warn(`[IMPRESSAO] Rota autenticada recusou (${r.motivo}): ${r.erro}`);
    // Rede fora é o único caso em que ainda vale tentar o caminho antigo: o
    // nosso servidor pode estar inacessível e o Supabase não. Nos demais,
    // insistir pelo caminho velho só mascararia o que precisa ser visto.
    if (r.motivo !== 'rede') return;
  }

  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  if (!empresaId) return;
  const { error } = await supabase.from('pdv_impressao').upsert({
    empresa_id: empresaId,
    print_server_url: url,
    terminal_id: store.get('config.terminal_id') || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'empresa_id' });
  if (error) console.warn('[IMPRESSAO] Caminho antigo também falhou:', error.message);
}

async function buscarUrlImpressao() {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  if (!empresaId) return null;
  const { data, error } = await supabase.from('pdv_impressao').select('print_server_url').eq('empresa_id', empresaId).maybeSingle();
  if (error) { console.warn('[IMPRESSAO] Erro ao buscar URL:', error.message); return null; }
  return data?.print_server_url || null;
}

// ─── Autenticação PDV ─────────────────────────────────────────────────

async function autenticarPDV(login, senha) {
  try {
    // Calculado localmente e usado pra duas coisas: (1) enviado como
    // p_senha_hash pra autenticar_operador_pdv() comparar dentro do banco
    // (a senha em texto puro nunca sai do terminal), e (2) guardado no
    // cache OFFLINE local pra permitir login sem internet depois. A
    // função já existe no Supabase (criada em supabase-fechar-acesso-publico.sql,
    // rodada 1 do fechamento de privilégios) e nunca devolve senha_hash.
    const senhaHash = crypto.createHash('sha256').update(senha).digest('hex');

    const { data: linhas, error } = await supabase.rpc('autenticar_operador_pdv', {
      p_login: login, p_senha_hash: senhaHash,
    });
    if (error) throw new Error(error.message);
    // Mesma mensagem genérica pra login inexistente e senha errada — dizer
    // qual dos dois foi conta pra um estranho quais logins existem.
    if (!linhas || !linhas.length) return { erro: 'Operador ou senha inválidos' };

    const u = linhas[0];

    let depositoNome = null;
    if (u.deposito_id) {
      const { data: dep } = await supabase.from('depositos').select('nome').eq('id', u.deposito_id).single();
      depositoNome = dep?.nome || null;
    }

    const usuario = {
      id: u.id,
      // autenticar_operador_pdv() não devolve login — usa o parâmetro que
      // o próprio operador digitou.
      nome: u.nome || login,
      login,
      cargo: u.cargo || 'Operador',
      empresa_id: u.empresa_id,
      empresa_nome: u.empresa_nome || 'VargasNexus PDV',
      empresa_fiscal_id: u.empresa_fiscal_id || u.empresa_id,
      empresa_fiscal_nome: u.empresa_fiscal_nome || u.empresa_nome,
      empresa_estoque_id: u.empresa_estoque_id || u.empresa_id,
      empresa_estoque_nome: u.empresa_estoque_nome || u.empresa_nome,
      deposito_id: u.deposito_id || null,
      deposito_nome: depositoNome,
      unificar_estoque: u.unificar_estoque || false,
      permissoes: u.permissoes || {},
    };

    store.set('auth.token', u.id);
    store.set('auth.usuario', usuario);
    store.set('auth.empresa_id', usuario.empresa_id);
    store.set('auth.empresa_fiscal_id', usuario.empresa_fiscal_id);
    store.set('auth.empresa_estoque_id', usuario.empresa_estoque_id);
    store.set('auth.deposito_id', usuario.deposito_id);

    const cacheKey = `auth.cache.${login}`;
    store.set(cacheKey, { senhaHash, usuario, token: u.id });

    return { token: u.id, usuario };
  } catch (err) {
    const cacheKey = `auth.cache.${login}`;
    const cache = store.get(cacheKey);
    if (cache) {
      const senhaHash = crypto.createHash('sha256').update(senha).digest('hex');
      if (cache.senhaHash === senhaHash) {
        store.set('auth.token', cache.token);
        store.set('auth.usuario', cache.usuario);
        store.set('auth.empresa_id', cache.usuario.empresa_id);
        store.set('auth.empresa_fiscal_id', cache.usuario.empresa_fiscal_id);
        store.set('auth.empresa_estoque_id', cache.usuario.empresa_estoque_id);
        store.set('auth.deposito_id', cache.usuario.deposito_id);
        return { token: cache.token, usuario: cache.usuario, offline: true };
      }
      return { erro: 'Senha incorreta (modo offline)' };
    }
    return { erro: 'Sem conexão e sem login salvo. Conecte à internet para o primeiro acesso.' };
  }
}

module.exports = {
  ping,
  sincronizarProdutos,
  contarProdutosRemoto,
  getProduto,
  atualizarProduto,
  criarProdutoRemoto,
  sincronizarEstoque,
  registrarVenda,
  editarVenda,
  cancelarVenda,
  enviarMovimentacaoEstoque,
  ajustarEstoqueRemoto: _ajustarEstoqueCAS, // usado pela fila de reparo de estoque (sync.js)
  listarVendasCloud,
  sincronizarVendedores,
  registrarCliente,
  atualizarCliente,
  atualizarClienteEndereco,
  sincronizarClientes,
  sincronizarClientesMesclados,
  sincronizarContasReceber,
  pagarContaReceber,
  pagarContaReceberParcial,
  getCreditosDoCliente,
  sincronizarCreditosCliente,
  receberCreditoCliente,
  criarCreditoCliente,
  usarCreditoEmConta,
  registrarFalta,
  atualizarFalta,
  listarFaltasRemoto,
  sincronizarConfigDesconto,
  sincronizarConfigTermometro,
  sincronizarEnderecosProdutos,
  atualizarUrlImpressao,
  buscarUrlImpressao,
  autenticarPDV,

  // Fora do escopo desta fase — stubs
  registrarEntrega: _naoDisponivel('Entregas'),
  listarEntregasRemoto: _naoDisponivel('Entregas'),
  atualizarEntrega: _naoDisponivel('Entregas'),
  listarAnunciosRemoto: _naoDisponivel('Marketplace'),
  upsertAnuncio: _naoDisponivel('Marketplace'),
  sincronizarAnunciosBase44: _naoDisponivel('Marketplace'),
  enviarPedidoBase44: _naoDisponivel('Marketplace'),
  criarSeparacao: _naoDisponivel('Marketplace'),
  atualizarSeparacao: _naoDisponivel('Marketplace'),
  mapearAnuncioBase44: _naoDisponivel('Marketplace'),
  getIdProdutoGenerico: _naoDisponivel('Marketplace'),
  sincronizarOrcamento,
  salvarOrcamentoAutenticado,
  sincronizarOrcamentos,
  orcamentosCanceladosNoServidor,
  lerOrcamentoAutenticado,
  converterOrcamentoAutenticado,
  atualizarStatusOrcamento,
  atualizarOrcamento,
  listarOrcamentosCloud,
  getOrcamentoCloud,
  registrarNfceVenda: _naoDisponivel('NFC-e'),
  chamarPdvProxy,
  repararClienteNasVendas: _naoDisponivel('Manutenção'),
};

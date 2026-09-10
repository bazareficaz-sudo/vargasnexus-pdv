/**
 * sync.js — Motor de sincronização offline-first
 *
 * Estratégia:
 * 1. Dados locais sempre têm prioridade para operações (PDV nunca trava)
 * 2. A cada X minutos (ou manualmente), sincroniza com Base44
 * 3. Conflitos são resolvidos por timestamp (servidor ganha em produtos/estoque,
 *    local ganha em vendas)
 * 4. Fila de operações pendentes é processada quando internet volta
 */

const Store = require('electron-store');
const store = new Store();
const db = require('./database');
const api = require('./api');

let syncInterval = null;
let isSyncing = false;
let isOnline = false;
let mainWindowRef = null;

const SYNC_INTERVAL_MS = 2 * 60 * 1000; // 2 minutos

// ─── Status público ───────────────────────────────────────────────
let syncStatus = {
  online: false,
  ultima_sync: store.get('sync.ultima_sync') || null,
  em_andamento: false,
  pendentes: 0,
  erro: null,
  ultimo_sync_produtos: null, // { modo: 'completo'|'incremental', total } — ver syncDownProdutos
};

function getStatus() { return { ...syncStatus }; }

function emitir(win, event, data) {
  try { win?.webContents?.send(event, data); } catch {}
}

// ─── Verificar conectividade ──────────────────────────────────────
async function checkOnline() {
  const online = await api.ping();
  if (online !== isOnline) {
    isOnline = online;
    syncStatus.online = online;
    emitir(mainWindowRef, 'sync:update', syncStatus);

    if (online) {
      console.log('[SYNC] Conexão restaurada — iniciando sync');
      await syncNow(mainWindowRef);
    } else {
      console.log('[SYNC] Sem conexão — modo offline ativo');
    }
  }
  return online;
}

// ─── Sincronização principal ──────────────────────────────────────
async function syncNow(win) {
  if (isSyncing) return { ok: false, msg: 'Sync já em andamento' };
  mainWindowRef = win || mainWindowRef;
  isSyncing = true;
  syncStatus.em_andamento = true;
  emitir(mainWindowRef, 'sync:update', syncStatus);

  let resultado = { ok: false, erros: [] };

  try {
    const online = await api.ping();
    if (!online) {
      isOnline = false;
      syncStatus.online = false;
      syncStatus.em_andamento = false;
      isSyncing = false;
      emitir(mainWindowRef, 'sync:update', syncStatus);
      return { ok: false, msg: 'Sem conexão com o servidor' };
    }

    isOnline = true;
    syncStatus.online = true;

    // 0. Seguir as unificações de cliente feitas no sistema web ANTES de
    // qualquer envio. Uma venda enviada com o id de um cadastro que virou
    // cópia funciona (o banco redireciona por gatilho), mas a conta a
    // receber e o extrato nascem apontando pro lugar errado até o gatilho
    // agir — e a linha local esquecida vira a semente da próxima cópia.
    await syncDownClientesMesclados();

    // 1. Upload: enviar alterações locais antes de sobrescrever com download
    await syncUpProdutos();
    await recuperarClientesPendentes();
    await processarFilaSync();
    await recuperarVendasPendentes();
    await processarReparoEstoque();

    // 2. Baixar dados do servidor (servidor → local) — agora o Base44 já tem os dados locais
    await syncDownProdutos();
    await syncDownClientes();
    await syncDownEstoque();
    await syncDownVendedores();
    await syncDownCreditosCliente();
    await syncDownContasReceber();
    await syncDownConfigDesconto();
    await syncDownConfigTermometro();
    await syncDownEnderecos();
    await syncDownUrlImpressao();
    await syncDownFaltas();
    await syncDownOrcamentos();
    await syncDownCancelamentosOrcamentos();

    // Atualizar timestamps
    const agora = new Date().toISOString();
    store.set('sync.ultima_sync', agora);
    syncStatus.ultima_sync = agora;
    syncStatus.erro = null;
    resultado.ok = true;

    console.log('[SYNC] Sincronização concluída:', agora);
  } catch (err) {
    console.error('[SYNC] Erro:', err.message);
    syncStatus.erro = err.message;
    resultado.erros.push(err.message);
  } finally {
    isSyncing = false;
    syncStatus.em_andamento = false;
    syncStatus.pendentes = db.sync.getPendentes().length;
    emitir(mainWindowRef, 'sync:update', syncStatus);
  }

  return resultado;
}

// ─── Download: Servidor → Local ───────────────────────────────────

// Mapeia campos do Supabase → schema local SQLite
function mapProduto(p) {
  return {
    id:          p.id,
    nome:        p.nome,
    sku:         p.sku         || null,
    ean:         p.ean         || null,
    preco_venda: p.preco_venda || 0,
    preco_custo: p.preco_custo || 0,
    unidade:     p.unidade     || 'UN',
    categoria:   p.categoria   || null,
    marca:       p.marca       || null,
    foto_url:    p.foto_url    || null,
    ativo:          p.ativo !== false,
    disponivel_pdv: p.disponivel_pdv !== false,
    permite_fracao: !!p.permite_fracao || p.unidade === 'KG' || p.unidade === 'LT' || p.unidade === 'MT',
    updated_at:     p.updated_at || new Date().toISOString(),
    estoque:        p.estoque      || 0,
    estoque_minimo: p.estoque_minimo || 0,
    // Campos fiscais
    ncm:       p.ncm       || null,
    cfop:      p.cfop      || null,
    icms_cst:  p.icms_cst  || null,
    icms_origem: p.icms_origem ?? 0,
    pis_cst:   p.pis_cst   || null,
    cofins_cst:p.cofins_cst|| null,
    tags:      Array.isArray(p.tags) ? p.tags : [],
    // Promoção — mesmos campos e mesma regra de vigência de
    // pdv-vargas-web/src/lib/produtos/promocao.ts (promocaoVigente/precoVigente).
    preco_promocional: p.preco_promocional ?? null,
    promocao_ativa:    !!p.promocao_ativa,
    promocao_inicio:   p.promocao_inicio || null,
    promocao_fim:      p.promocao_fim || null,
  };
}

function mapCliente(c) {
  return {
    id:               c.id,
    nome:             c.nome,
    cpf_cnpj:         c.cpf_cnpj        || null,
    telefone:         c.telefone        || null,
    whatsapp:         c.whatsapp        || null,
    email:            c.email           || null,
    cep:              c.cep             || null,
    logradouro:       c.logradouro      || c.endereco || null,
    numero:           c.numero          || null,
    complemento:      c.complemento     || null,
    bairro:           c.bairro          || null,
    cidade:           c.cidade          || null,
    estado:           c.estado          || null,
    referencia:       c.referencia      || null,
    obs_entrega:      c.obs_entrega     || null,
    limite_credito:   c.limite_credito  || 0,
    saldo_credito:    c.saldo_credito   || 0,
    saldo_devedor:    c.saldo_devedor   || 0,
    status_credito:   c.status_credito  || 'liberado',
    permite_carteira: c.permite_carteira || false,
    updated_at:       c.updated_at      || new Date().toISOString(),
  };
}

async function syncDownProdutos() {
  emitir(mainWindowRef, 'sync:update', { ...syncStatus, progresso: 'Sincronizando produtos...' });

  let totalSalvos = 0;

  // Sync incremental por updated_at — o Supabase tem um trigger que mantém
  // esse campo em dia em qualquer UPDATE (entrada, inventário, preço, PDV
  // etc.), então dá pra confiar nele. Se o banco local estiver vazio
  // (primeira vez, ou depois de um reset), força sync completo.
  const totalLocal = db.produtos.total();
  let ultimaSync = totalLocal > 0 ? store.get('sync.ultima_sync_produtos') : null;

  // Reconciliação única pós-rollout dos campos de promoção (v1.8.15): o
  // sync incremental só resgata produtos cujo updated_at mudou depois do
  // checkpoint local — produtos com promoção configurada ANTES desse
  // rollout nunca teriam o updated_at tocado de novo, então nunca
  // chegariam ao terminal. Uma carga completa, uma única vez, resolve.
  const forcarBackfillPromo = !store.get('sync.produtos_promo_backfill_v1');
  if (forcarBackfillPromo) ultimaSync = null;

  // Rede de segurança: se o catálogo local ficou muito menor que o remoto
  // (limpeza de dados legados, corrupção, etc.), o sync incremental nunca
  // resgataria os produtos que sumiram localmente — o updated_at deles no
  // servidor não mudou. Compara as contagens e força sync completo se a
  // diferença for grande demais.
  if (ultimaSync) {
    try {
      const totalRemoto = await api.contarProdutosRemoto();
      if (totalRemoto > 0 && totalLocal < totalRemoto * 0.9) {
        console.warn(`[SYNC] Catálogo local (${totalLocal}) muito menor que o remoto (${totalRemoto}) — forçando sync completo de produtos`);
        ultimaSync = null;
      }
    } catch (e) {
      console.warn('[SYNC] Falha ao checar contagem remota de produtos, mantendo sync incremental:', e.message);
    }
  }

  const inicioSync = new Date().toISOString();

  await api.sincronizarProdutos(ultimaSync, (lote, total) => {
    db.produtos.upsertBatch(lote.map(mapProduto));
    totalSalvos = total;
    if (total % 500 === 0 || lote.length < 200) {
      emitir(mainWindowRef, 'sync:update', { ...syncStatus, progresso: `Produtos: ${total} sincronizados...` });
    }
  });

  store.set('sync.ultima_sync_produtos', inicioSync);
  if (forcarBackfillPromo) store.set('sync.produtos_promo_backfill_v1', true);
  const modo = ultimaSync ? 'incremental' : 'completo';
  console.log(`[SYNC] Produtos: ${totalSalvos} sincronizados (${modo})`);

  // Fica disponível em getStatus() mesmo depois que "em_andamento" volta pra
  // false — é o que deixa o operador perceber sozinho, na própria tela, se
  // um catálogo veio incompleto (foi a ausência disso que deixou passar o
  // incidente dos 192 produtos sem ninguém notar).
  syncStatus.ultimo_sync_produtos = { modo, total: totalSalvos };
  emitir(mainWindowRef, 'sync:update', syncStatus);
}

async function syncForcarProdutos() {
  // Força re-sync completo ignorando o checkpoint incremental
  store.delete('sync.ultima_sync_produtos');
  return syncDownProdutos();
}

// Aplica localmente as unificações feitas no sistema web. Roda ANTES do
// download de clientes: o cadastro que virou cópia não vem mais na lista
// (o sync só traz ativos), então a linha local precisa ser apontada pro
// sobrevivente antes, ou ela nunca mais é encontrada e vira a semente da
// próxima cópia.
async function syncDownClientesMesclados() {
  try {
    const pares = await api.sincronizarClientesMesclados();
    db.clientes.aplicarMesclagens(pares);
  } catch (err) {
    // Não é crítico: sem isso a venda ainda sobe certo (o banco redireciona
    // por gatilho), só o cadastro local fica desatualizado.
    console.warn('[SYNC] Unificações de cliente: erro (não crítico):', err.message);
  }
}

async function syncDownClientes() {
  // Reconciliação única pós-limpeza de duplicatas (v1.8.9): a limpeza local
  // (database.js, deduplicarClientesLocal) escolhe qual linha local
  // sobrevive só por sinal local (referências, mais antiga) — não tem como
  // saber, sem rede, se o remote_id dela ainda existe depois da limpeza
  // feita direto no Supabase (duplicatas antigas foram apagadas de lá). Uma
  // carga completa (ignorando o checkpoint) corrige sozinha qualquer linha
  // local cujo remote_id ainda seja válido; a que sobrou com remote_id
  // morto fica intocada (não dá erro, só não recebe mais atualização).
  const forcarPosLimpeza = !store.get('sync.clientes_dedup_reconciliado_v1');
  const ultimaSync = forcarPosLimpeza ? null : store.get('sync.ultima_sync_clientes');
  emitir(mainWindowRef, 'sync:update', { ...syncStatus, progresso: 'Sincronizando clientes...' });

  const clientes = await api.sincronizarClientes(ultimaSync);
  if (forcarPosLimpeza) store.set('sync.clientes_dedup_reconciliado_v1', true);
  if (clientes.length > 0) {
    db.clientes.upsertBatch(clientes.map(mapCliente));
    store.set('sync.ultima_sync_clientes', new Date().toISOString());
    console.log(`[SYNC] Clientes: ${clientes.length} atualizados`);
  } else {
    console.log('[SYNC] Clientes: nenhuma atualização');
  }
}

async function syncForcarClientes() {
  // Força re-sync completo ignorando data de última sync
  store.delete('sync.ultima_sync_clientes');
  const clientes = await api.sincronizarClientes(null);
  if (clientes.length > 0) {
    db.clientes.upsertBatch(clientes.map(mapCliente));
    store.set('sync.ultima_sync_clientes', new Date().toISOString());
  }
  console.log(`[SYNC] Clientes forçado: ${clientes.length} sincronizados`);
  return { total: clientes.length };
}

async function syncDownEstoque() {
  // Estoque já vem junto dos produtos — não precisa de chamada separada
  console.log('[SYNC] Estoque sincronizado junto com produtos');
}

async function syncDownVendedores() {
  try {
    const vendedores = await api.sincronizarVendedores();
    if (vendedores.length > 0) {
      db.vendedores.upsertBatch(vendedores.map(v => ({ ...v, updated_date: v.updated_at || v.updated_date || null })));
      console.log(`[SYNC] Vendedores: ${vendedores.length} sincronizados`);
    }
  } catch (err) {
    console.warn('[SYNC] Vendedores: erro (não crítico):', err.message);
  }
}

async function syncDownCreditosCliente() {
  emitir(mainWindowRef, 'sync:update', { ...syncStatus, progresso: 'Sincronizando créditos...' });
  try {
    const creditos = await api.sincronizarCreditosCliente();
    if (creditos.length > 0) {
      db.creditosCliente.upsertBatch(creditos);
      console.log(`[SYNC] CreditosCliente: ${creditos.length} registros sincronizados`);
    } else {
      console.log('[SYNC] CreditosCliente: nenhum registro em aberto');
    }
  } catch (err) {
    console.warn('[SYNC] CreditosCliente: erro (não crítico):', err.message);
  }
}

async function syncDownContasReceber() {
  emitir(mainWindowRef, 'sync:update', { ...syncStatus, progresso: 'Sincronizando contas a receber...' });
  try {
    const contas = await api.sincronizarContasReceber();
    if (contas.length > 0) {
      db.contasReceber.upsertBatch(contas);
      console.log(`[SYNC] ContasReceber: ${contas.length} registros sincronizados`);
    } else {
      console.log('[SYNC] ContasReceber: nenhum registro pendente');
    }
  } catch (err) {
    console.warn('[SYNC] ContasReceber: erro (não crítico):', err.message);
  }
}

async function syncDownFaltas() {
  try {
    const faltas = await api.listarFaltasRemoto();
    if (faltas.length > 0) {
      db.faltas.upsertFromRemote(faltas);
      console.log(`[SYNC] Faltas: ${faltas.length} sincronizadas`);
    }
  } catch (err) {
    console.warn('[SYNC] Faltas: erro (não crítico):', err.message);
  }
}

async function syncDownOrcamentos() {
  try {
    const orcamentos = await api.sincronizarOrcamentos();
    if (orcamentos.length > 0) {
      const r = db.orcamentos.upsertBatch(orcamentos);
      console.log(`[SYNC] Orçamentos: ${r.total} do servidor — ${r.atualizados} atualizados, `
        + `${r.inseridos} novos, ${r.preservados} preservados, ${r.ambiguos} ambíguos, `
        + `${r.falhas.length} falhas`);
      // Identidade ambígua: duas ou mais linhas locais dizem ser o mesmo
      // documento. Nada foi escrito, de propósito — decidir aqui esconderia
      // uma corrupção histórica atrás de uma escolha automática. Vai inteiro
      // para o log, com todos os ids e números envolvidos.
      for (const a of r.ambiguidades) {
        console.warn(`[SYNC] Orçamentos: ${a.motivo} — cloud ${a.cloud_id} (nº${a.numero_cloud})`
          + ` casa com ids locais [${a.ids_locais.join(', ')}]`
          + ` remote_ids [${a.remote_ids_locais.join(', ')}]`
          + ` números [${a.numeros_locais.join(', ')}] — nada alterado`);
      }
      // Uma linha que falha não derruba as outras desde a 0.6C.3. Mas também
      // não some: o que não foi aplicado é dito, com quem e por quê.
      if (r.falhas.length) {
        console.warn(`[SYNC] Orçamentos: ${r.falhas.length} não aplicados —`,
          r.falhas.slice(0, 3).map(f => `nº${f.numero}: ${f.erro}`).join(' | '));
      }
    }
  } catch (err) {
    console.warn('[SYNC] Orçamentos: erro (não crítico):', err.message);
  }
}

// FASE 0.6C.4 — cancelamento não desce pela consulta de ativos.
//
// `syncDownOrcamentos` busca `status IN ('aberto')`. Um orçamento cancelado
// noutro terminal simplesmente some do lote, e a linha local fica 'aberto'
// para sempre — com botão de editar, converter em venda e cancelar de novo.
// Este segundo fluxo pergunta, só pelos documentos que ESTE terminal já tem,
// quais o servidor considera cancelados.
//
// Fluxo separado de propósito: a descida de ativos, validada na 0.6C.3, não é
// tocada, e uma falha aqui não pode atrapalhar aquela.
async function syncDownCancelamentosOrcamentos() {
  try {
    const identidades = db.orcamentos.identidadesConhecidas();
    if (!identidades.length) return;
    const cancelados = await api.orcamentosCanceladosNoServidor(identidades);
    if (!cancelados.length) return;

    const r = db.orcamentos.aplicarCancelamentos(cancelados);
    console.log(`[SYNC] Orçamentos cancelados: ${r.total} recebidos, ${r.aplicados} aplicados, `
      + `${r.ja_cancelados} já cancelados, ${r.conflitos.length} conflitos, `
      + `${r.desconhecidos} desconhecidos, ${r.ambiguos} ambíguos, ${r.falhas.length} falhas`);

    // Conflito não se resolve sozinho, então precisa ser dito.
    for (const c of r.conflitos) {
      console.warn(`[SYNC] Orçamento nº${c.numero}: cancelamento remoto não aplicado —`
        + ` existe operação local pendente (${c.sync_status}`
        + `${c.tem_op_chave ? ', com chave de operação viva' : ''}).`);
    }
    for (const a of r.ambiguidades) {
      console.warn(`[SYNC] Orçamentos cancelados: ${a.motivo} — cloud ${a.cloud_id} (nº${a.numero_cloud})`
        + ` casa com ids locais [${a.ids_locais.join(', ')}]`
        + ` remote_ids [${a.remote_ids_locais.join(', ')}] — nada alterado`);
    }
    if (r.falhas.length) {
      console.warn(`[SYNC] Orçamentos cancelados: ${r.falhas.length} não aplicados —`,
        r.falhas.slice(0, 3).map((f) => `nº${f.numero}: ${f.erro}`).join(' | '));
    }
  } catch (err) {
    console.warn('[SYNC] Orçamentos cancelados: erro (não crítico):', err.message);
  }
}

// Terminal-caixa não precisa disso — ele imprime local e é quem publica a
// URL. Terminais de venda buscam a URL publicada e se auto-configuram.
async function syncDownUrlImpressao() {
  if (store.get('config.print_server_ativo') === true) return;
  try {
    const url = await api.buscarUrlImpressao();
    if (url && url !== store.get('config.print_server_ip')) {
      store.set('config.print_server_ip', url);
      console.log('[SYNC] URL de impressão atualizada:', url);
    }
  } catch (err) {
    console.warn('[SYNC] URL de impressão: erro (não crítico):', err.message);
  }
}

async function syncDownConfigTermometro() {
  try {
    const cfg = await api.sincronizarConfigTermometro();
    if (cfg) {
      store.set('config_termometro', {
        margem_excelente: cfg.margem_excelente ?? 30,
        margem_boa:       cfg.margem_boa       ?? 15,
        margem_media:     cfg.margem_media      ?? 8,
        // Formas de pagamento que preservam o preço promocional — mesma
        // lista usada nos orçamentos (supabase-orcamento-promo-estrategia.sql),
        // pra não ter duas definições diferentes de "à vista" no sistema.
        promo_formas: Array.isArray(cfg.orcamento_promo_formas) && cfg.orcamento_promo_formas.length
          ? cfg.orcamento_promo_formas
          : ['pix', 'dinheiro'],
      });
      console.log('[SYNC] ConfigTermometro sincronizado');
    }
  } catch (err) {
    console.warn('[SYNC] ConfigTermometro: erro (não crítico):', err.message);
  }
}

async function syncDownEnderecos() {
  try {
    const enderecos = await api.sincronizarEnderecosProdutos();
    db.produtoLocalizacao.substituirTudo(enderecos);
    console.log(`[SYNC] Localização de produtos: ${enderecos.length} endereçados neste depósito`);
  } catch (err) {
    console.warn('[SYNC] Localização de produtos: erro (não crítico):', err.message);
  }
}

async function syncDownConfigDesconto() {
  try {
    const configs = await api.sincronizarConfigDesconto();
    if (configs.length > 0) {
      // Indexar por faixa para acesso rápido no renderer
      const porFaixa = {};
      for (const c of configs) {
        porFaixa[c.faixa_lucratividade] = {
          desconto_maximo: c.desconto_maximo ?? null,
          formas_pagamento_aceitas: c.formas_pagamento_aceitas || [],
          permitir_parcelado: c.permitir_parcelado ?? true,
        };
      }
      store.set('config_desconto', porFaixa);
      console.log(`[SYNC] ConfigDesconto: ${configs.length} faixas sincronizadas`);
    }
  } catch (err) {
    console.warn('[SYNC] ConfigDesconto: erro (não crítico):', err.message);
  }
}

// ─── Orçamentos: monta o payload aceito por api.sincronizarOrcamento a
// partir do retorno de db.orcamentos.payloadSync() (itens já com
// produto_remote_id resolvido). Usado tanto pelo envio imediato (main.js)
// quanto pelo reenvio via fila (abaixo), para não duplicar o mapeamento.
function montarPayloadOrcamentoRemoto(orcPayload) {
  const usuario = store.get('auth.usuario') || {};
  return {
    empresa_id: usuario.empresa_estoque_id || usuario.empresa_id || store.get('auth.empresa_id'),
    numero: orcPayload.numero,
    cliente_nome: orcPayload.cliente_nome || null,
    vendedor_nome: orcPayload.vendedor_nome || usuario.nome || null,
    subtotal: orcPayload.subtotal,
    desconto_total: orcPayload.desconto || 0,
    total: orcPayload.total,
    observacao: orcPayload.observacao || null,
    validade_dias: orcPayload.validade_dias || 7,
    itens: orcPayload.itens.map(i => ({
      produto_id: i.produto_remote_id || null,
      produto_nome: i.produto_nome,
      produto_sku: i.produto_sku || null,
      quantidade: i.quantidade,
      preco_unitario: i.preco_unitario,
      desconto: i.desconto || 0,
      subtotal: i.total,
    })),
  };
}

// Local usa 'pendente' como status inicial; no Supabase o valor equivalente
// é 'aberto' (definido no insert de sincronizarOrcamento). Demais status
// (cancelado, convertido) já usam o mesmo nome dos dois lados.
function statusOrcamentoRemoto(statusLocal) {
  return statusLocal === 'pendente' ? 'aberto' : statusLocal;
}

// Envia ao servidor a criação de uma venda: resolve cliente_remote_id se
// preciso e chama api.registrarVenda(). Extraído da fila automática pra
// também ser chamado pelo retry manual (Vendas > 🔄 Retentar) — aquele
// caminho precisa do erro de verdade, não pode ficar escondido atrás de
// "tentativas esgotadas, desisto silenciosamente" como a fila faz.
async function _sincronizarVendaCreate(vendaId) {
  const venda = db.vendas.getById(vendaId);
  if (!venda) throw new Error('Venda não encontrada localmente');
  if (venda.status === 'cancelada') return null;
  if (venda.remote_id) return venda.remote_id;

  // Se há cliente local sem remote_id, tentar sincronizar agora antes da venda
  if (venda.cliente_id && !venda.cliente_remote_id) {
    const cli = db.db().prepare('SELECT * FROM clientes WHERE id = ?').get(venda.cliente_id);
    if (cli && !cli.remote_id) {
      try {
        const cRes = await api.registrarCliente(cli);
        if (cRes?.id) {
          db.db().prepare('UPDATE clientes SET remote_id = ?, sync_status = ?, synced_at = ? WHERE id = ?')
            .run(cRes.id, 'synced', new Date().toISOString(), cli.id);
          venda.cliente_remote_id = cRes.id;
          console.log(`[SYNC] Cliente "${cli.nome}" sincronizado antes da venda`);
        }
      } catch (e) {
        // Não bloqueia a venda por causa do cliente — ela sobe sem vínculo,
        // mas ao menos fica registrado o motivo (antes isso era silencioso).
        console.warn(`[SYNC] Falha ao sincronizar cliente antes da venda (venda segue sem vínculo): ${e.message}`);
      }
    } else if (cli?.remote_id) {
      venda.cliente_remote_id = cli.remote_id;
    }
  }

  const res = await api.registrarVenda(venda);
  if (res?.id) {
    db.db().prepare('UPDATE vendas SET remote_id = ?, sync_status = ?, synced_at = ? WHERE id = ?')
      .run(res.id, 'synced', new Date().toISOString(), vendaId);
  }
  // A venda subiu, mas algum item pode não ter mexido no estoque. Guarda a
  // dívida para a fila de reparo em vez de deixar a diferença correr solta.
  for (const f of res?.falhasEstoque || []) {
    db.estoqueReparo.registrar({
      vendaId, produtoRemoteId: f.produto_id, produtoNome: f.produto_nome,
      delta: f.delta, contexto: f.contexto, etapa: f.etapa, motivo: f.motivo,
      saldoJaBaixado: f.saldoJaBaixado,
    });
  }
  // registrarVenda pode ter resolvido um cliente_id diferente do que
  // mandamos (o em cache não existia mais no Supabase — ver
  // _resolverOuCriarClienteRemoto em api.js). Atualiza o cache local pra
  // não bater no mesmo problema na próxima venda desse cliente.
  if (venda.cliente_id && res?.cliente_id_usado && res.cliente_id_usado !== venda.cliente_remote_id) {
    db.db().prepare('UPDATE clientes SET remote_id = ?, sync_status = ?, synced_at = ? WHERE id = ?')
      .run(res.cliente_id_usado, 'synced', new Date().toISOString(), venda.cliente_id);
    console.log(`[SYNC] Cliente "${venda.cliente_nome}" — remote_id corrigido após venda`);
  }
  return res?.id || null;
}

// Retry manual disparado pelo operador (botão "🔄 Retentar" na tela de
// Vendas) — ao contrário da fila, propaga o erro de verdade em vez de só
// registrar tentativa e desistir depois de 5 falhas sem avisar ninguém.
async function retentarVendaManual(vendaId) {
  const remoteId = await _sincronizarVendaCreate(vendaId);
  return { ok: true, remoteId };
}

// ─── Upload: Local → Servidor (fila pendente) ─────────────────────
async function processarFilaSync() {
  const pendentes = db.sync.getPendentes();
  if (pendentes.length === 0) return;

  emitir(mainWindowRef, 'sync:update', { ...syncStatus, progresso: `Enviando ${pendentes.length} operações pendentes...` });
  console.log(`[SYNC] Processando ${pendentes.length} operações pendentes`);

  for (const item of pendentes) {
    try {
      const payload = JSON.parse(item.payload);

      if (item.entidade === 'venda') {
        if (item.operacao === 'create') {
          await _sincronizarVendaCreate(payload.venda_id);
        } else if (item.operacao === 'update' && payload.status === 'cancelada') {
          const venda = db.db().prepare('SELECT remote_id FROM vendas WHERE id = ?').get(payload.venda_id);
          if (venda?.remote_id) {
            await api.cancelarVenda(venda.remote_id, payload.motivo);
          }
        }
      }

      if (item.entidade === 'falta') {
        const falta = db.db().prepare('SELECT * FROM faltas WHERE id = ?').get(payload.falta_id);
        if (falta) {
          if (item.operacao === 'create' && !falta.remote_id) {
            // busca remote_id do produto se existir
            const prod = falta.produto_id
              ? db.db().prepare('SELECT remote_id FROM produtos WHERE id = ?').get(falta.produto_id)
              : null;
            const res = await api.registrarFalta({ ...falta, produto_remote_id: prod?.remote_id });
            if (res?.id) {
              db.db().prepare('UPDATE faltas SET remote_id = ?, sync_status = ?, synced_at = ? WHERE id = ?')
                .run(res.id, 'synced', new Date().toISOString(), falta.id);
            }
          } else if (item.operacao === 'update' && falta.remote_id) {
            await api.atualizarFalta(falta.remote_id, { status: payload.status });
          }
        }
      }

      if (item.entidade === 'cliente') {
        if (item.operacao === 'create') {
          const cliente = db.db().prepare('SELECT * FROM clientes WHERE id = ?').get(payload.cliente_id);
          if (cliente && !cliente.remote_id) {
            const res = await api.registrarCliente(cliente);
            if (res?.id) {
              db.db().prepare('UPDATE clientes SET remote_id = ?, sync_status = ?, synced_at = ? WHERE id = ?')
                .run(res.id, 'synced', new Date().toISOString(), payload.cliente_id);
              console.log(`[SYNC] Cliente "${cliente.nome}" → Base44 ${res.id}`);
            }
          }
        } else if (item.operacao === 'update_endereco') {
          // Manda o endereço/telefone atuais do cliente local (não um
          // snapshot de quando foi enfileirado) — se o operador editou de
          // novo antes desta rodada rodar, já vai a versão mais recente.
          const cliente = db.db().prepare('SELECT * FROM clientes WHERE id = ?').get(payload.cliente_id);
          if (!cliente) throw new Error('Cliente não encontrado para atualizar endereço');
          // Cliente cadastrado na mesma venda pode ainda não ter remote_id
          // (registro roda no bloco 'create' acima, na mesma passada da
          // fila) — lança erro pra essa atualização tentar de novo na
          // próxima sincronização, quando o remote_id já vai existir.
          if (!cliente.remote_id) throw new Error('Cliente ainda sem remote_id — tenta de novo na próxima sincronização');
          await api.atualizarClienteEndereco(cliente.remote_id, {
            telefone: cliente.telefone, whatsapp: cliente.whatsapp, cep: cliente.cep,
            logradouro: cliente.logradouro, numero: cliente.numero, complemento: cliente.complemento,
            bairro: cliente.bairro, cidade: cliente.cidade, estado: cliente.estado,
            referencia: cliente.referencia, obs_entrega: cliente.obs_entrega,
          });
          db.db().prepare("UPDATE clientes SET sync_status = 'synced' WHERE id = ?").run(cliente.id);
          console.log(`[SYNC] Endereço de "${cliente.nome}" sincronizado`);
        }
      }

      if (item.entidade === 'estoque') {
        const mov = db.db().prepare('SELECT * FROM movimentacoes_estoque WHERE id = ?').get(payload.mov_id);
        if (mov) {
          // O produto pode ter sido criado no balcão e só depois ganhar
          // remote_id — sem ele o ajuste não tem onde pegar no Supabase.
          const prod = mov.produto_id
            ? db.db().prepare('SELECT remote_id FROM produtos WHERE id = ?').get(mov.produto_id)
            : null;
          await api.enviarMovimentacaoEstoque({ ...mov, produto_remote_id: prod?.remote_id });
          db.db().prepare("UPDATE movimentacoes_estoque SET sync_status = 'synced' WHERE id = ?").run(mov.id);
        }
      }

      if (item.entidade === 'orcamento') {
        // A fila e TRANSPORTE da mesma operacao, nao uma segunda
        // implementacao da regra. Ela reexecuta o comando com a MESMA chave
        // persistida — e e por isso que imediata + retry dao um efeito so.
        const { criarComandoOrcamento } = require('./orcamentoComando');
        const cmd = criarComandoOrcamento({ db, api, terminal: require('./terminal') });
        const r = await cmd.executar(payload.orcamento_id, payload.acao || 'salvar');
        // 'erro' e transitorio: lanca para o item continuar na fila com a
        // mesma chave. Os demais desfechos ja encerraram o item.
        if (r.tipo === 'erro') throw new Error(r.erro || 'Falha ao sincronizar orcamento');
      }

      if (item.entidade === 'orcamento_alheio') {
        // 0.6C.5 — documento de outro terminal. A fila carrega a operacao
        // inteira porque nao ha documento local de onde reconstrui-la.
        const { criarComandoOrcamento } = require('./orcamentoComando');
        const cmd = criarComandoOrcamento({ db, api, terminal: require('./terminal') });
        const r = await cmd.executarAlheio(payload);
        // 'erro' e transitorio e volta para a fila com a MESMA chave.
        // 'conflito' e 'indisponivel' nao se resolvem repetindo: encerram aqui
        // e ja foram ditos no log.
        if (r.tipo === 'erro') throw new Error(r.erro || 'Falha em orcamento alheio');
      }

      db.sync.marcarProcessado(item.id);
    } catch (err) {
      console.error(`[SYNC] Erro ao processar item ${item.id}:`, err.message);
      db.sync.marcarErro(item.id, err.message, item.tentativas + 1);
      // Se falhou muitas vezes, marcar como processado para não travar a fila
      if (item.tentativas >= 5) db.sync.marcarProcessado(item.id);
    }
  }
}

// ─── Recuperar clientes locais sem remote_id ─────────────────────
async function recuperarClientesPendentes() {
  const clientesPendentes = db.db().prepare(`
    SELECT id FROM clientes
    WHERE remote_id IS NULL AND sync_status != 'error'
    AND NOT EXISTS (
      SELECT 1 FROM sync_queue sq
      WHERE sq.payload LIKE '%' || clientes.id || '%'
      AND sq.processado = 0
    )
  `).all();

  if (clientesPendentes.length === 0) return;

  console.log(`[SYNC] Recuperando ${clientesPendentes.length} clientes sem sync...`);
  const now = new Date().toISOString();

  for (const { id } of clientesPendentes) {
    try {
      const cliente = db.db().prepare('SELECT * FROM clientes WHERE id = ?').get(id);
      if (!cliente) continue;
      const res = await api.registrarCliente(cliente);
      if (res?.id) {
        db.db().prepare('UPDATE clientes SET remote_id = ?, sync_status = ?, synced_at = ? WHERE id = ?')
          .run(res.id, 'synced', now, id);
        console.log(`[SYNC] Cliente "${cliente.nome}" recuperado → Base44 ${res.id}`);
      }
    } catch (err) {
      console.error(`[SYNC] Falha ao recuperar cliente ${id}:`, err.message);
    }
  }
}

// ─── Reparo de estoque: retentar o que o Supabase recusou ─────────
//
// Uma baixa que não passou continua devendo até passar. Só a parte que
// faltou é refeita: quando produtos.estoque já saiu e o que falhou foi o
// espelho por depósito ou o rastro, refazer o ajuste inteiro tiraria o
// saldo duas vezes — por isso saldo_ja_baixado existe.
async function processarReparoEstoque() {
  const pendentes = db.estoqueReparo.getPendentes();
  if (!pendentes.length) return;

  console.log(`[SYNC] Reparo de estoque: ${pendentes.length} pendência(s)`);
  let resolvidas = 0;

  for (const p of pendentes) {
    try {
      const contexto = JSON.parse(p.contexto || '{}');

      if (p.saldo_ja_baixado) {
        // produtos.estoque já foi baixado nesta venda; refazer o CAS
        // duplicaria a saída. Estas ficam registradas para o painel web
        // reconciliar (espelho por depósito e rastro), sem mexer no saldo.
        db.estoqueReparo.marcarTentativa(p.id, p.motivo);
        continue;
      }

      const r = await api.ajustarEstoqueRemoto(p.produto_remote_id, Number(p.delta), contexto);
      if (r?.ok) {
        db.estoqueReparo.marcarResolvido(p.id);
        resolvidas++;
        console.log(`[SYNC] Estoque reparado: ${p.produto_nome} (${p.delta})`);
      } else {
        db.estoqueReparo.marcarTentativa(p.id, `${r?.etapa || 'desconhecida'}: ${r?.motivo || 'sem detalhe'}`);
      }
    } catch (err) {
      db.estoqueReparo.marcarTentativa(p.id, err.message);
      console.warn(`[SYNC] Reparo de estoque falhou para ${p.produto_nome}:`, err.message);
    }
  }

  const restantes = db.estoqueReparo.contarPendentes();
  console.log(`[SYNC] Reparo de estoque: ${resolvidas} resolvida(s), ${restantes} pendente(s)`);
  if (restantes) emitir(mainWindowRef, 'sync:update', { ...syncStatus, estoquePendente: restantes });
}

// ─── Recuperar vendas pendentes sem entrada na fila ───────────────
async function recuperarVendasPendentes() {
  // Busca vendas locais sem remote_id (nunca sincronizadas) que não estão na fila ativa
  const vendasPendentes = db.db().prepare(`
    SELECT v.id FROM vendas v
    WHERE v.remote_id IS NULL AND v.status != 'cancelada'
    AND NOT EXISTS (
      SELECT 1 FROM sync_queue sq
      WHERE sq.payload LIKE '%' || v.id || '%'
      AND sq.processado = 0
    )
  `).all();

  if (vendasPendentes.length === 0) return;

  console.log(`[SYNC] Recuperando ${vendasPendentes.length} vendas sem sync...`);
  const now = new Date().toISOString();
  const { v4: uuidv4 } = require('uuid');

  for (const { id } of vendasPendentes) {
    try {
      const venda = db.vendas.getById(id);
      if (!venda) continue;
      const res = await api.registrarVenda(venda);
      if (res?.id) {
        db.db().prepare('UPDATE vendas SET remote_id = ?, sync_status = ?, synced_at = ? WHERE id = ?')
          .run(res.id, 'synced', now, id);
        console.log(`[SYNC] Venda #${venda.numero} recuperada → Base44 ${res.id}`);
      }
      for (const f of res?.falhasEstoque || []) {
        db.estoqueReparo.registrar({
          vendaId: id, produtoRemoteId: f.produto_id, produtoNome: f.produto_nome,
          delta: f.delta, contexto: f.contexto, etapa: f.etapa, motivo: f.motivo,
          saldoJaBaixado: f.saldoJaBaixado,
        });
      }
    } catch (err) {
      console.error(`[SYNC] Falha ao recuperar venda ${id}:`, err.message);
    }
  }
}

// ─── Upload: produtos alterados/criados localmente → Supabase ─────
async function syncUpProdutos() {
  const dbb = db.db();
  const now = new Date().toISOString();

  // Produtos criados no balcão (sem remote_id ainda) — precisam existir no
  // Supabase antes que uma venda desse produto possa referenciá-lo direito.
  const novos = dbb.prepare(`
    SELECT id, nome, sku, ean, preco_venda, preco_custo, unidade, categoria, marca, foto_url, ativo, permite_fracao
    FROM produtos
    WHERE sync_status = 'pending' AND remote_id IS NULL
    LIMIT 50
  `).all();

  let criados = 0;
  for (const p of novos) {
    try {
      const res = await api.criarProdutoRemoto(p);
      dbb.prepare(`UPDATE produtos SET remote_id = ?, sync_status = 'synced', synced_at = ? WHERE id = ?`)
        .run(res.id, now, p.id);
      criados++;
    } catch (err) {
      console.error(`[SYNC] Produto "${p.nome}" erro ao criar no Supabase:`, err.message);
      dbb.prepare(`UPDATE produtos SET sync_status = 'error' WHERE id = ?`).run(p.id);
    }
  }
  if (criados) console.log(`[SYNC] Produtos: ${criados} criados no Supabase`);

  // Produtos já existentes no Supabase com edição local pendente (fiscal, preço etc.)
  const pendentes = dbb.prepare(`
    SELECT id, remote_id, nome, ncm, cfop, icms_cst, icms_origem,
           pis_cst, cofins_cst, disponivel_pdv, preco_venda, preco_custo,
           categoria, marca, unidade
    FROM produtos
    WHERE sync_status = 'pending' AND remote_id IS NOT NULL
    LIMIT 100
  `).all();

  if (!pendentes.length) return;

  console.log(`[SYNC] Produtos: enviando ${pendentes.length} alterações para o Supabase`);
  let ok = 0;

  for (const p of pendentes) {
    try {
      await api.atualizarProduto(p.remote_id, p);
      dbb.prepare(`UPDATE produtos SET sync_status = 'synced', synced_at = ? WHERE id = ?`)
        .run(now, p.id);
      ok++;
    } catch(err) {
      console.error(`[SYNC] Produto "${p.nome}" erro:`, err.message);
      dbb.prepare(`UPDATE produtos SET sync_status = 'error' WHERE id = ?`).run(p.id);
    }
  }
  if (ok) console.log(`[SYNC] Produtos: ${ok} atualizados no Supabase`);
}

// ─── Sync leve: só envia a fila pendente (usado após cada venda) ──
async function syncFila(win) {
  if (isSyncing) return; // sync completo já em andamento, não duplicar
  mainWindowRef = win || mainWindowRef;

  const online = await api.ping();
  if (!online) return;

  try {
    // syncUpProdutos primeiro: se a venda que está na fila inclui um produto
    // criado no balcão (ainda sem remote_id), ele precisa existir no
    // Supabase antes da venda ser enviada, senão o item some sem produto.
    await syncUpProdutos();
    await recuperarClientesPendentes();
    await processarFilaSync();
    syncStatus.pendentes = db.sync.getPendentes().length;
    emitir(mainWindowRef, 'sync:update', syncStatus);
    console.log('[SYNC] Fila enviada após venda');
  } catch (err) {
    console.warn('[SYNC] syncFila erro:', err.message);
  }
}

// ─── Auto-sync periódico ──────────────────────────────────────────
function startAutoSync(win) {
  mainWindowRef = win;

  // Checar online a cada 30 segundos
  setInterval(() => checkOnline(), 30000);

  // Sync completo a cada 5 minutos quando online
  syncInterval = setInterval(async () => {
    if (isOnline && !isSyncing) await syncNow(mainWindowRef);
  }, SYNC_INTERVAL_MS);

  // Sync inicial após 3 segundos (dar tempo de abrir a janela)
  setTimeout(() => syncNow(mainWindowRef), 3000);
}

function stopAutoSync() {
  if (syncInterval) clearInterval(syncInterval);
}

async function syncForcarCarteira() {
  // Re-sync completo: limpa créditos locais obsoletos antes de re-inserir
  // (créditos cancelados/ajustados no Base44 não voltam no sync incremental)
  const clientes = await api.sincronizarClientes(null);
  if (clientes.length > 0) db.clientes.upsertBatch(clientes.map(mapCliente));

  const creditos = await api.sincronizarCreditosCliente();
  db.creditosCliente.limparTodos();
  if (creditos.length > 0) db.creditosCliente.upsertBatch(creditos);

  const contas = await api.sincronizarContasReceber();
  db.contasReceber.limparTodos();
  if (contas.length > 0) db.contasReceber.upsertBatch(contas);

  console.log(`[SYNC] Carteira forçada: ${clientes.length} clientes, ${creditos.length} créditos, ${contas.length} contas`);
  return { clientes: clientes.length, creditos: creditos.length, contas: contas.length };
}

module.exports = { startAutoSync, stopAutoSync, syncNow, syncFila, getStatus, checkOnline, syncUpProdutos, syncForcarClientes, syncForcarCarteira, syncForcarProdutos, montarPayloadOrcamentoRemoto, retentarVendaManual };

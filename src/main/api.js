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

function _naoDisponivel(nome) {
  return async () => {
    throw new Error(`${nome}: recurso ainda não migrado nesta versão do VargasNexus PDV`);
  };
}

// ─── Ping ─────────────────────────────────────────────────────────────

async function ping() {
  try {
    const { error } = await supabase.from('produtos').select('id', { count: 'exact', head: true }).limit(1);
    return !error;
  } catch { return false; }
}

// ─── Estoque (interno) ──────────────────────────────────────────────

async function _ajustarEstoqueCAS(produtoId, delta) {
  if (!produtoId) return;
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const { data: produto } = await supabase.from('produtos').select('estoque').eq('id', produtoId).single();
    if (!produto) return;
    const novoEstoque = Number(produto.estoque || 0) + delta;
    const { data: atualizado } = await supabase.from('produtos')
      .update({ estoque: novoEstoque })
      .eq('id', produtoId).eq('estoque', produto.estoque)
      .select('id').maybeSingle();
    if (atualizado) return;
  }
  console.warn('[ESTOQUE] Conflito de concorrência persistente para produto', produtoId);
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
async function criarProdutoRemoto(produto) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  const { data, error } = await supabase.from('produtos').insert({
    empresa_id: empresaId,
    nome: produto.nome,
    sku: produto.sku || null,
    ean: produto.ean || null,
    preco_venda: produto.preco_venda || 0,
    preco_custo: produto.preco_custo || 0,
    unidade: produto.unidade || 'UN',
    categoria: produto.categoria || null,
    marca: produto.marca || null,
    foto_url: produto.foto_url || null,
    ativo: produto.ativo !== false,
    disponivel_pdv: true,
    permite_fracao: !!produto.permite_fracao,
    estoque: produto.estoque || 0,
  }).select('id').single();
  if (error) throw new Error(error.message);
  return { id: data.id };
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

async function registrarVenda(venda) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id || venda.empresa_id;
  const itensPayload = (venda.itens || []).map(i => ({
    // Nunca usar i.produto_id (id local do SQLite) como fallback — isso
    // manda um UUID que parece válido mas não existe no Supabase, gerando
    // um item "órfão" sem bloquear o resto da venda. Sem remote_id ainda
    // resolvido (produto criado offline, sync não rodou), fica null — o
    // sistema web já trata null como "sem produto vinculado" corretamente.
    produto_id: i.produto_remote_id || null,
    produto_nome: i.produto_nome,
    produto_sku: i.produto_sku || null,
    quantidade: i.quantidade,
    preco_unitario: i.preco_unitario,
    desconto: i.desconto || 0,
    subtotal: i.total,
  }));

  const { data: novaVenda, error } = await supabase.from('vendas').insert({
    empresa_id: empresaId,
    empresa_fiscal_id: usuario.empresa_fiscal_id || empresaId,
    deposito_id: usuario.deposito_id || venda.deposito_id || null,
    numero: venda.numero,
    cliente_id: venda.cliente_remote_id || null,
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
    vendedor_id: venda.vendedor_id || null,
    vendedor_nome: venda.vendedor_nome || null,
    vendedor_codigo: venda.vendedor_codigo || null,
    itens: itensPayload,
  }).select().single();

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
      await _ajustarEstoqueCAS(i.produto_id, -Number(i.quantidade || 0));
    }
  }

  return { id: novaVenda.id };
}

async function editarVenda(remoteId, itens, totais, forma_pagamento) {
  const itensPayload = itens.map(i => ({
    // Nunca usar i.produto_id (id local do SQLite) como fallback — isso
    // manda um UUID que parece válido mas não existe no Supabase, gerando
    // um item "órfão" sem bloquear o resto da venda. Sem remote_id ainda
    // resolvido (produto criado offline, sync não rodou), fica null — o
    // sistema web já trata null como "sem produto vinculado" corretamente.
    produto_id: i.produto_remote_id || null,
    produto_nome: i.produto_nome,
    produto_sku: i.produto_sku || null,
    quantidade: i.quantidade,
    preco_unitario: i.preco_unitario,
    desconto: i.desconto || 0,
    subtotal: i.total,
  }));

  const { error } = await supabase.from('vendas').update({
    subtotal: totais.subtotal,
    desconto: totais.desconto || 0,
    desconto_total: totais.desconto || 0,
    total: totais.total,
    forma_pagamento,
    valor_pago: totais.valor_pago || totais.total,
    valor_recebido: totais.valor_pago || totais.total,
    troco: totais.troco || 0,
    itens: itensPayload,
  }).eq('id', remoteId);
  if (error) throw new Error(error.message);

  await supabase.from('venda_itens').delete().eq('venda_id', remoteId);
  if (itensPayload.length) {
    await supabase.from('venda_itens').insert(
      itensPayload.map(i => ({ venda_id: remoteId, ...i, total: i.subtotal, tipo: 'venda' }))
    );
  }
  return { ok: true };
}

async function cancelarVenda(remoteId, motivo) {
  const { data: itens } = await supabase.from('venda_itens').select('produto_id, quantidade').eq('venda_id', remoteId);
  for (const i of itens || []) {
    await _ajustarEstoqueCAS(i.produto_id, Number(i.quantidade || 0));
  }
  const { error } = await supabase.from('vendas').update({
    status: 'cancelada',
    motivo_cancelamento: motivo,
  }).eq('id', remoteId);
  if (error) throw new Error(error.message);
  return { ok: true };
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

async function registrarCliente(cliente) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
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

async function registrarFalta(falta) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  const id = uuidv4();
  const { error } = await supabase.from('faltas').insert({
    id,
    empresa_id: empresaId,
    produto_id: falta.produto_remote_id || null,
    produto_nome: falta.produto_nome,
    produto_sku: falta.produto_sku || null,
    cliente_nome: falta.cliente_nome || null,
    cliente_telefone: falta.cliente_telefone || null,
    quantidade_solicitada: falta.quantidade_solicitada || 1,
    observacao: falta.observacao || null,
    status: falta.status || 'pendente',
    origem: falta.origem || 'pdv',
    usuario_nome: falta.usuario_nome || null,
  });
  if (error) throw new Error(error.message);
  return { id };
}

async function atualizarFalta(remoteId, dados) {
  const { error } = await supabase.from('faltas').update(dados).eq('id', remoteId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

async function listarFaltasRemoto() {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  let query = supabase.from('faltas').select('*').in('status', ['pendente', 'notificado', 'comprado']).order('created_at', { ascending: false }).limit(200);
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
      produto_id: i.produto_id || null,
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
        produto_id: i.produto_remote_id || i.produto_id || null,
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

async function sincronizarConfigTermometro() {
  return null;
}

// ─── Impressão em rede (URL do tunnel do terminal-caixa) ──────────────

async function atualizarUrlImpressao(url) {
  const usuario = store.get('auth.usuario') || {};
  const empresaId = usuario.empresa_estoque_id || usuario.empresa_id;
  if (!empresaId) return;
  const { error } = await supabase.from('pdv_impressao').upsert({
    empresa_id: empresaId,
    print_server_url: url,
    terminal_id: store.get('config.terminal_id') || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'empresa_id' });
  if (error) console.warn('[IMPRESSAO] Erro ao publicar URL:', error.message);
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
    const senhaHash = crypto.createHash('sha256').update(senha).digest('hex');

    const { data: usuarios, error } = await supabase
      .from('usuarios_pdv')
      .select('*')
      .eq('login', login)
      .eq('ativo', true)
      .limit(1);
    if (error) throw new Error(error.message);
    if (!usuarios || !usuarios.length) return { erro: 'Operador não encontrado' };

    const u = usuarios[0];
    if (u.senha_hash !== senhaHash) return { erro: 'Senha incorreta' };

    let depositoNome = null;
    if (u.deposito_id) {
      const { data: dep } = await supabase.from('depositos').select('nome').eq('id', u.deposito_id).single();
      depositoNome = dep?.nome || null;
    }

    const usuario = {
      id: u.id,
      nome: u.nome || u.login,
      login: u.login,
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
  listarVendasCloud,
  sincronizarVendedores,
  registrarCliente,
  atualizarCliente,
  atualizarClienteEndereco,
  sincronizarClientes,
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
  sincronizarOrcamentos,
  atualizarStatusOrcamento,
  atualizarOrcamento,
  listarOrcamentosCloud,
  getOrcamentoCloud,
  registrarNfceVenda: _naoDisponivel('NFC-e'),
  chamarPdvProxy: _naoDisponivel('WhatsApp'),
  repararClienteNasVendas: _naoDisponivel('Manutenção'),
};

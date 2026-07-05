/**
 * api.js — Cliente Base44 (Entities API)
 */

const fetch = require('node-fetch');
const Store = require('electron-store');
const store = new Store();

const APP_ID  = '69fcb430127e4ced004d7e69';
const API_KEY = '67216247308e4b96989b61626f7fd87b';
const BASE_URL = `https://app.base44.com/api/apps/${APP_ID}`;

function headers() {
  return {
    'Content-Type': 'application/json',
    'api_key': API_KEY,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

async function get(path, params = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : v);
  }
  const res = await fetch(url.toString(), { method: 'GET', headers: headers(), timeout: 30000 });
  if (!res.ok) throw new Error(`Base44 GET ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function post(path, body = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(body), timeout: 30000
  });
  if (!res.ok) throw new Error(`Base44 POST ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function put(path, body = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'PUT', headers: headers(), body: JSON.stringify(body), timeout: 30000
  });
  if (!res.ok) throw new Error(`Base44 PUT ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── Ping ─────────────────────────────────────────────────────────────

async function ping() {
  try {
    const res = await fetch(`https://app.base44.com/api/apps/${APP_ID}/entities/Produto?limit=1`, {
      method: 'GET', headers: headers(), timeout: 5000
    });
    return res.ok;
  } catch { return false; }
}

// ─── Produtos ─────────────────────────────────────────────────────────

/**
 * Busca todos os produtos ativos.
 * onProgress(totalBaixados) — chamado a cada lote para atualizar UI.
 * Retorna os produtos em lotes via callback para economizar memória em catálogos 14k+.
 */
async function sincronizarProdutos(ultimaSync = null, onBatch = null) {
  const limit = 200;
  let skip = 0;
  let totalBaixados = 0;
  const todos = [];

  const query = { ativo: true };
  if (ultimaSync) query.updated_date = { $gt: ultimaSync };

  while (true) {
    const res = await get('/entities/Produto', { q: query, limit, skip });
    const items = Array.isArray(res) ? res : (res.results || res.data || []);

    if (items.length > 0) {
      totalBaixados += items.length;
      if (onBatch) {
        onBatch(items, totalBaixados);
      } else {
        todos.push(...items);
      }
      skip += items.length;
    }

    if (items.length < limit) break;

    await new Promise(r => setTimeout(r, 150));
  }

  return onBatch ? totalBaixados : todos;
}

async function getProduto(id) {
  return get(`/entities/Produto/${id}`);
}

// ─── Vendas ───────────────────────────────────────────────────────────

/**
 * Registra uma venda no Base44.
 * A venda local já foi salva — aqui só sincroniza.
 */
const EMPRESA_ID = '69fcc1ef22ce2c5e401104a7';

async function registrarVenda(venda) {
  const usuario = store.get('auth.usuario') || {};
  const payload = {
    empresa_id:        usuario.empresa_estoque_id  || venda.empresa_id        || EMPRESA_ID,
    empresa_fiscal_id: usuario.empresa_fiscal_id   || venda.empresa_fiscal_id || null,
    deposito_id:       usuario.deposito_id          || venda.deposito_id       || null,
    numero: venda.numero,
    cliente_id: venda.cliente_remote_id || null,
    cliente_nome: venda.cliente_nome || null,
    status: venda.status || 'finalizada',
    subtotal: venda.subtotal,
    desconto_total: venda.desconto || 0,
    total: venda.total,
    forma_pagamento: venda.forma_pagamento,
    valor_recebido: venda.valor_pago,
    troco: venda.troco || 0,
    observacao: venda.observacao || null,
    terminal_id: store.get('config.terminal_id') || 'PDV-001',
    vendedor_id: venda.vendedor_id || null,
    vendedor_nome: venda.vendedor_nome || null,
    vendedor_codigo: venda.vendedor_codigo || null,
    created_date: venda.created_at,
    itens: (venda.itens || []).map(i => ({
      produto_id: i.produto_remote_id || i.produto_id,
      produto_nome: i.produto_nome,
      produto_sku: i.produto_sku || null,
      quantidade: i.quantidade,
      preco_unitario: i.preco_unitario,
      desconto: i.desconto || 0,
      subtotal: i.total,
    })),
  };
  return post('/entities/Venda', payload);
}

async function editarVenda(remoteId, itens, totais, forma_pagamento) {
  return put(`/entities/Venda/${remoteId}`, {
    subtotal:        totais.subtotal,
    desconto_total:  totais.desconto || 0,
    total:           totais.total,
    forma_pagamento: forma_pagamento,
    valor_recebido:  totais.valor_pago || totais.total,
    troco:           totais.troco || 0,
    itens: itens.map(i => ({
      produto_id:     i.produto_id,
      produto_nome:   i.produto_nome,
      produto_sku:    i.produto_sku || null,
      quantidade:     i.quantidade,
      preco_unitario: i.preco_unitario,
      desconto:       i.desconto || 0,
      subtotal:       i.total,
    })),
  });
}

async function cancelarVenda(remoteId, motivo) {
  return put(`/entities/Venda/${remoteId}`, { status: 'cancelada', motivo_cancelamento: motivo });
}

async function listarVendasCloud(data) {
  // Busca sem filtro de data — filtra localmente depois (mais compatível com Base44)
  const q = { empresa_id: EMPRESA_ID };
  const res = await get('/entities/Venda', { q: JSON.stringify(q), limit: 500, sort: JSON.stringify({ created_date: -1 }) });
  const lista = Array.isArray(res) ? res : (res.results || res.data || []);
  console.log('[CLOUD] Total vendas recebidas:', lista.length, '| campos ex:', lista[0] ? Object.keys(lista[0]).join(',') : 'vazio');
  // Filtrar pela data localmente — aceita created_date ou created_at
  return lista.filter(v => {
    const dt = v.created_date || v.created_at || '';
    return dt.startsWith(data);
  });
}

// ─── Vendedores ───────────────────────────────────────────────────────

async function sincronizarVendedores() {
  const res = await get('/entities/Vendedor', { q: { ativo: true }, limit: 200 });
  return Array.isArray(res) ? res : (res.results || []);
}

// ─── CreditoCliente (Contas a Receber) ────────────────────────────────

async function sincronizarCreditosCliente() {
  const todos = [];
  const limit = 200;
  let skip = 0;
  // Apenas status em aberto/parcial — as pagas não precisam de sync contínuo
  const query = { empresa_id: EMPRESA_ID, status: { $in: ['aberto', 'usado_parcialmente'] } };
  while (true) {
    const res = await get('/entities/CreditoCliente', { q: query, limit, skip, sort_by: '-created_date' });
    const items = Array.isArray(res) ? res : (res.results || []);
    todos.push(...items);
    if (items.length < limit) break;
    skip += items.length;
  }
  return todos;
}

async function getCreditosDoCliente(clienteRemoteId) {
  const query = { cliente_id: clienteRemoteId, status: { $in: ['aberto', 'usado_parcialmente'] } };
  const res = await get('/entities/CreditoCliente', { q: query, limit: 50, sort_by: 'created_date' });
  return Array.isArray(res) ? res : (res.results || []);
}

async function receberCreditoCliente(remoteId, saldoNovo, novoStatus, observacao) {
  return put(`/entities/CreditoCliente/${remoteId}`, {
    saldo_atual: saldoNovo,
    status: novoStatus,
    observacao: observacao || null,
  });
}

// ─── ContaReceber (Fiado / Carteira) ──────────────────────────────────

async function sincronizarContasReceber() {
  const todos = [];
  const limit = 200;
  let skip = 0;
  // Sem filtro de status — Base44 pode não suportar $nin.
  // Filtragem feita localmente no SQLite (NOT IN 'pago','cancelado','quitado').
  while (true) {
    const res = await get('/entities/ContaReceber', { limit, skip, sort_by: 'vencimento' });
    const items = Array.isArray(res) ? res : (res.results || []);
    todos.push(...items);
    if (items.length < limit) break;
    skip += items.length;
  }
  return todos;
}

async function pagarContaReceber(contaId, formaPagamento, observacao) {
  return put(`/entities/ContaReceber/${contaId}`, {
    status: 'pago',
    data_pagamento: new Date().toISOString().split('T')[0],
    forma_recebimento: formaPagamento || 'dinheiro',
    observacao: observacao || null,
  });
}

async function pagarContaReceberParcial(contaId, valorPago, valorOriginal, formaPagamento, observacao) {
  const valorRestante = Math.round((valorOriginal - valorPago) * 100) / 100;
  // Atualiza o valor da conta para o restante (pagamento parcial)
  return put(`/entities/ContaReceber/${contaId}`, {
    valor: valorRestante,
    observacao: `Pgto parcial R$ ${valorPago.toFixed(2)} (${formaPagamento || 'dinheiro'})${observacao ? ' — ' + observacao : ''}`,
  });
}

async function usarCreditoEmConta(contaId, contaValor, creditoId, creditoSaldoAtual, formaPagamento, observacao) {
  const hoje = new Date().toISOString().split('T')[0];
  if (creditoSaldoAtual >= contaValor) {
    // Crédito cobre a conta inteira — quita a conta, abate o crédito
    await put(`/entities/ContaReceber/${contaId}`, {
      status: 'pago',
      data_pagamento: hoje,
      forma_recebimento: 'credito_loja',
      observacao: observacao || 'Pago com crédito loja',
    });
    const novoSaldo = Math.round((creditoSaldoAtual - contaValor) * 100) / 100;
    await put(`/entities/CreditoCliente/${creditoId}`, {
      saldo_atual: novoSaldo,
      status: novoSaldo <= 0 ? 'usado_totalmente' : 'usado_parcialmente',
    });
    return { quitou: true, saldoCreditoRestante: novoSaldo };
  } else {
    // Crédito não cobre tudo — abate parcialmente a conta, zera o crédito
    const valorRestante = Math.round((contaValor - creditoSaldoAtual) * 100) / 100;
    await put(`/entities/ContaReceber/${contaId}`, {
      valor: valorRestante,
      observacao: `Crédito loja R$ ${creditoSaldoAtual.toFixed(2)} aplicado — restam R$ ${valorRestante.toFixed(2)}`,
    });
    await put(`/entities/CreditoCliente/${creditoId}`, {
      saldo_atual: 0,
      status: 'usado_totalmente',
    });
    return { quitou: false, saldoCreditoRestante: 0, valorRestante };
  }
}

// ─── Clientes ─────────────────────────────────────────────────────────

async function registrarCliente(cliente) {
  const payload = {
    empresa_id: EMPRESA_ID,
    nome: cliente.nome,
    cpf_cnpj: cliente.cpf_cnpj || null,
    telefone: cliente.telefone || null,
    email: cliente.email || null,
    limite_credito: cliente.limite_credito || 0,
    saldo_credito: cliente.saldo_credito || 0,
    ativo: true,
  };
  return post('/entities/Cliente', payload);
}

async function atualizarCliente(remoteId, dados) {
  return put(`/entities/Cliente/${remoteId}`, dados);
}

async function atualizarClienteEndereco(remoteId, dados) {
  // Atualiza só campos não-nulos para não sobrescrever dados existentes
  const payload = {};
  const campos = ['telefone','whatsapp','cep','logradouro','numero','complemento','bairro','cidade','estado','referencia','obs_entrega'];
  campos.forEach(c => { if (dados[c]) payload[c] = dados[c]; });
  if (!Object.keys(payload).length) return null;
  return put(`/entities/Cliente/${remoteId}`, payload);
}

async function sincronizarClientes(ultimaSync = null) {
  const clientes = [];
  const limit = 200;
  let skip = 0;
  const usuario = store.get('auth.usuario') || {};

  // Respeita empresa de estoque; se unificar_estoque, busca sem filtro de empresa
  const query = {};
  if (!usuario.unificar_estoque && usuario.empresa_estoque_id) {
    query.empresa_id = usuario.empresa_estoque_id;
  }
  if (ultimaSync) query.updated_date = { $gt: ultimaSync };

  while (true) {
    const res = await get('/entities/Cliente', { q: JSON.stringify(query), limit, skip });
    const items = Array.isArray(res) ? res : (res.results || []);
    clientes.push(...items);
    if (items.length < limit) break;
    skip += limit;
  }

  return clientes;
}

// ─── Faltas ───────────────────────────────────────────────────────────

async function registrarFalta(falta) {
  return post('/entities/Falta', {
    empresa_id: EMPRESA_ID,
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
}

async function atualizarFalta(remoteId, dados) {
  return put(`/entities/Falta/${remoteId}`, dados);
}

async function listarFaltasRemoto() {
  const res = await get('/entities/Falta', {
    q: { empresa_id: EMPRESA_ID, status: { $in: ['pendente', 'notificado', 'comprado'] } },
    limit: 200,
    sort_by: '-created_date',
  });
  return Array.isArray(res) ? res : (res.results || []);
}

// ─── ConfigDesconto ───────────────────────────────────────────────────

async function sincronizarConfigDesconto() {
  const res = await get('/entities/ConfigDesconto', {
    q: { empresa_id: EMPRESA_ID },
    limit: 20,
  });
  return Array.isArray(res) ? res : (res.results || []);
}

// ─── Autenticação PDV ─────────────────────────────────────────────────

async function autenticarPDV(login, senha) {
  try {
    const crypto = require('crypto');
    const senhaHash = crypto.createHash('sha256').update(senha).digest('hex');

    const res = await get('/entities/UsuarioPDV', {
      q: { login, empresa_id: EMPRESA_ID, ativo: true },
      limit: 1,
    });
    const usuarios = Array.isArray(res) ? res : (res.results || []);
    if (usuarios.length === 0) return { erro: 'Operador não encontrado' };

    const u = usuarios[0];
    if (u.senha_hash !== senhaHash) return { erro: 'Senha incorreta' };

    // Base44 armazena configs de empresa/estoque dentro do objeto permissoes
    const perms = u.permissoes || {};
    const usuario = {
      id:                  u.id,
      nome:                u.nome || u.login,
      login:               u.login,
      cargo:               u.cargo || 'Operador',
      empresa_id:          u.empresa_id,
      empresa_nome:        u.empresa_nome || 'Bazar Eficaz',
      // Empresa fiscal: campo empresa_emissao_fiscal_id dentro de permissoes
      empresa_fiscal_id:   perms.empresa_emissao_fiscal_id || u.empresa_fiscal_id || u.empresa_id,
      empresa_fiscal_nome: u.empresa_fiscal_nome || null,
      // Empresa de estoque: campo estoque_empresa_id dentro de permissoes
      empresa_estoque_id:  perms.estoque_empresa_id  || u.empresa_estoque_id  || u.empresa_id,
      empresa_estoque_nome:u.empresa_estoque_nome || null,
      // Depósito: campo estoque_deposito_id dentro de permissoes
      deposito_id:         perms.estoque_deposito_id || u.deposito_id || null,
      deposito_nome:       u.deposito_nome || null,
      unificar_estoque:    perms.unificar_estoque || u.unificar_estoque || false,
      permissoes:          perms,
    };
    // Buscar dados completos da empresa fiscal, estoque, depósito e config fiscal (em paralelo)
    try {
      const [resFiscal, resEstoque, resDep, resCfgFiscal] = await Promise.allSettled([
        get(`/entities/Empresa/${usuario.empresa_fiscal_id}`),
        usuario.empresa_estoque_id !== usuario.empresa_fiscal_id
          ? get(`/entities/Empresa/${usuario.empresa_estoque_id}`) : Promise.resolve(null),
        usuario.deposito_id
          ? get(`/entities/Deposito/${usuario.deposito_id}`) : Promise.resolve(null),
        get('/entities/ConfigFiscal', { q: JSON.stringify({ empresa_id: usuario.empresa_fiscal_id }), limit: 1 }),
      ]);

      if (resFiscal.status === 'fulfilled' && resFiscal.value) {
        const ef = resFiscal.value;
        // Nomes exatos dos campos no Base44 (Empresa)
        usuario.empresa_fiscal_nome      = ef.nome          || usuario.empresa_fiscal_id;
        usuario.empresa_fiscal_fantasia  = ef.fantasia       || ef.nome || null;
        usuario.empresa_fiscal_cnpj      = ef.cnpj           || null;
        usuario.empresa_fiscal_ie        = ef.ie             || null;
        usuario.empresa_fiscal_im        = ef.im             || null;
        usuario.empresa_fiscal_regime    = ef.regime_tributario || 'simples_nacional';
        usuario.empresa_fiscal_uf        = ef.estado         || null;
        usuario.empresa_fiscal_cep       = ef.cep            || null;
        usuario.empresa_fiscal_logradouro= ef.logradouro     || null;
        usuario.empresa_fiscal_numero    = ef.numero         || 'S/N';
        usuario.empresa_fiscal_complemento = ef.complemento  || null;
        usuario.empresa_fiscal_bairro    = ef.bairro         || null;
        usuario.empresa_fiscal_municipio = ef.cidade         || null;  // Base44 usa "cidade"
        usuario.empresa_fiscal_telefone  = ef.telefone       || null;
        usuario.empresa_fiscal_token_focusnfe = ef.token_focusnfe || null;
      } else {
        usuario.empresa_fiscal_nome = usuario.empresa_nome;
      }

      if (resEstoque.status === 'fulfilled' && resEstoque.value) {
        usuario.empresa_estoque_nome = resEstoque.value.nome;
      } else {
        usuario.empresa_estoque_nome = usuario.empresa_fiscal_nome || usuario.empresa_nome;
      }

      if (resDep.status === 'fulfilled' && resDep.value) {
        usuario.deposito_nome = resDep.value.nome;
      }

      // ConfigFiscal: dados para emissão NFC-e
      if (resCfgFiscal.status === 'fulfilled') {
        const cfgList = Array.isArray(resCfgFiscal.value) ? resCfgFiscal.value : (resCfgFiscal.value?.results || []);
        const cfg = cfgList[0];
        if (cfg) {
          usuario.nfce_serie        = cfg.serie_nfce          || '001';
          usuario.nfce_ambiente     = cfg.ambiente             || 'homologacao';
          usuario.nfce_csc          = cfg.csc_nfce             || null;
          usuario.nfce_id_token     = cfg.id_token_nfce        || null;
          usuario.nfce_habilitada   = cfg.habilita_nfce        || false;
          // token FocusNFe homologação
          if (!usuario.empresa_fiscal_token_focusnfe && cfg.token_focusnfe) {
            usuario.empresa_fiscal_token_focusnfe = cfg.token_focusnfe;
          }
          // token FocusNFe produção (campo separado no Base44)
          if (cfg.token_focusnfe_producao) {
            usuario.empresa_fiscal_token_focusnfe_producao = cfg.token_focusnfe_producao;
          }
        }
      }

      // Salvar tokens e CNPJ nas configs do terminal para acesso rápido
      if (usuario.empresa_fiscal_token_focusnfe)
        store.set('config.fiscal_token', usuario.empresa_fiscal_token_focusnfe);
      if (usuario.empresa_fiscal_token_focusnfe_producao)
        store.set('config.fiscal_token_producao', usuario.empresa_fiscal_token_focusnfe_producao);
      if (usuario.empresa_fiscal_cnpj)
        store.set('config.fiscal_cnpj', usuario.empresa_fiscal_cnpj);
      if (usuario.nfce_ambiente)
        store.set('config.fiscal_ambiente', usuario.nfce_ambiente);

    } catch (err) {
      console.warn('[LOGIN] Erro ao buscar dados fiscais:', err.message);
    }

    store.set('auth.token', u.id);
    store.set('auth.usuario', usuario);
    store.set('auth.empresa_id',         usuario.empresa_id);
    store.set('auth.empresa_fiscal_id',  usuario.empresa_fiscal_id);
    store.set('auth.empresa_estoque_id', usuario.empresa_estoque_id);
    store.set('auth.deposito_id',        usuario.deposito_id);
    return { token: u.id, usuario };
  } catch (err) {
    return { erro: 'Erro de conexão: ' + err.message };
  }
}

// ─── Entregas ─────────────────────────────────────────────────────────

async function registrarEntrega(entrega) {
  return post('/entities/Entrega', {
    empresa_id: entrega.empresa_id || EMPRESA_ID,
    empresa_nome: entrega.empresa_nome || null,
    venda_id: entrega.venda_id || null,
    venda_numero: entrega.venda_numero || null,
    terminal_id: entrega.terminal_id || null,
    numero_local: entrega.numero_local || null,
    cliente_id: entrega.cliente_id || null,
    cliente_nome: entrega.cliente_nome || null,
    cliente_telefone: entrega.cliente_telefone || null,
    cliente_whatsapp: entrega.cliente_whatsapp || null,
    cep: entrega.cep || null,
    logradouro: entrega.logradouro || null,
    numero: entrega.numero || null,
    complemento: entrega.complemento || null,
    bairro: entrega.bairro || null,
    cidade: entrega.cidade || null,
    estado: entrega.estado || null,
    observacao: entrega.observacao || null,
    data_agendada: entrega.data_agendada || null,
    turno: entrega.turno || 'qualquer',
    itens: entrega.itens || [],
    valor_total_entrega: entrega.valor_total_entrega || 0,
    status: 'pendente',
    criado_por: entrega.criado_por || null,
    created_date: entrega.created_at || new Date().toISOString(),
  });
}

async function listarEntregasRemoto(empresaId, status = null) {
  const query = { empresa_id: empresaId || EMPRESA_ID };
  if (status) query.status = status;
  const res = await get('/entities/Entrega', { q: query, limit: 200, sort_by: '-created_date' });
  return Array.isArray(res) ? res : (res.results || []);
}

async function atualizarEntrega(remoteId, dados) {
  return put(`/entities/Entrega/${remoteId}`, dados);
}

// ─── ConfigTermometro ─────────────────────────────────────────────────

async function sincronizarConfigTermometro() {
  const res = await get('/entities/ConfigTermometro', {
    q: { empresa_id: EMPRESA_ID },
    limit: 5,
  });
  const items = Array.isArray(res) ? res : (res.results || []);
  return items[0] || null; // Uma config por empresa
}

// ─── Orçamentos ───────────────────────────────────────────────────────

async function sincronizarOrcamento(payload) {
  return post('/entities/Orcamento', payload);
}

async function atualizarStatusOrcamento(remoteId, status) {
  return put(`/entities/Orcamento/${remoteId}`, { status });
}

async function getOrcamentoCloud(remoteId) {
  const o = await get(`/entities/Orcamento/${remoteId}`);
  if (!o) return null;
  const itens = Array.isArray(o.itens) ? o.itens.map(i => ({
    produto_nome:   i.produto_nome || i.nome || '',
    quantidade:     i.quantidade || 1,
    preco_unitario: i.preco_unitario || 0,
    desconto:       i.desconto || 0,
    total:          i.total || i.subtotal || 0,
  })) : [];
  return {
    id:               o._id || o.id,
    remote_id:        o._id || o.id,
    numero:           o.numero || 0,
    status:           o.status || 'pendente',
    cliente_nome:     o.cliente_nome || null,
    cliente_telefone: o.cliente_telefone || null,
    forma_pagamento:  o.forma_pagamento || null,
    validade_dias:    o.validade_dias || 7,
    subtotal:         o.subtotal || 0,
    desconto:         o.desconto || 0,
    total:            o.total || 0,
    observacao:       o.observacao || null,
    vendedor_nome:    o.vendedor_nome || null,
    created_at:       o.created_date || o.created_at || new Date().toISOString(),
    itens,
  };
}

async function listarOrcamentosCloud(filtros = {}) {
  const q = { empresa_id: EMPRESA_ID };
  if (filtros.status) q.status = filtros.status;
  const res = await get('/entities/Orcamento', {
    q: JSON.stringify(q), limit: 500,
    sort: JSON.stringify({ created_date: -1 }),
  });
  const lista = Array.isArray(res) ? res : (res.results || res.data || []);
  return lista.map(o => ({
    id:               o._id || o.id,
    remote_id:        o._id || o.id,
    numero:           o.numero || 0,
    status:           o.status || 'pendente',
    cliente_nome:     o.cliente_nome || null,
    cliente_telefone: o.cliente_telefone || null,
    forma_pagamento:  o.forma_pagamento || null,
    validade_dias:    o.validade_dias || 7,
    subtotal:         o.subtotal || 0,
    desconto:         o.desconto || 0,
    total:            o.total || 0,
    observacao:       o.observacao || null,
    vendedor_nome:    o.vendedor_nome || null,
    created_at:       o.created_date || o.created_at || new Date().toISOString(),
    _origem:          'cloud',
  }));
}

// ─── Estoque ──────────────────────────────────────────────────────────

async function sincronizarEstoque(ultimaSync = null) {
  // O estoque vem junto com os produtos no campo `estoque`
  // Esta função busca os produtos com estoque atualizado
  const query = { ativo: true, controlar_estoque: true };
  if (ultimaSync) query.updated_date = { $gt: ultimaSync };

  const items = [];
  const limit = 200;
  let skip = 0;

  while (true) {
    const res = await get('/entities/Produto', { q: query, limit, skip });
    const batch = Array.isArray(res) ? res : (res.results || []);
    items.push(...batch);
    if (batch.length < limit) break;
    skip += limit;
  }

  return items;
}

// Atualiza campos de um produto no Base44 (remote_id obrigatório)
async function atualizarProduto(remoteId, dados) {
  // Mapeia campos locais → campos Base44
  const payload = {};
  if (dados.ncm        !== undefined) payload.ncm         = dados.ncm;
  if (dados.cfop       !== undefined) payload.cfop        = dados.cfop;
  if (dados.icms_cst   !== undefined) payload.csosn       = dados.icms_cst;
  if (dados.icms_origem!== undefined) payload.origem      = String(dados.icms_origem || 0);
  if (dados.pis_cst    !== undefined) payload.cst_pis     = dados.pis_cst;
  if (dados.cofins_cst !== undefined) payload.cst_cofins  = dados.cofins_cst;
  if (dados.disponivel_pdv !== undefined) payload.disponivel_pdv = !!dados.disponivel_pdv;
  if (dados.nome       !== undefined) payload.nome        = dados.nome;
  if (dados.preco_venda!== undefined) payload.preco_venda = dados.preco_venda;
  if (dados.preco_custo!== undefined) payload.custo       = dados.preco_custo;
  if (dados.categoria  !== undefined) payload.categoria   = dados.categoria;
  if (dados.marca      !== undefined) payload.marca       = dados.marca;
  if (dados.unidade    !== undefined) payload.unidade     = dados.unidade;
  return await put(`/entities/Produto/${remoteId}`, payload);
}

// ─── Separação (Pedidos Marketplace) ─────────────────────────────────

function _separacaoPayload(pedido, contaInfo) {
  const db = require('./database');
  const itensRaw = JSON.parse(pedido.itens_json || '[]');

  // Busca mapeamentos de todos os itens de uma vez
  const itemIds = itensRaw.map(i => i.marketplace_anuncio_id).filter(Boolean);
  const mapMap  = db.mktAnuncios.getMapeamentoPorItemIds(pedido.conta_id || contaInfo.id, itemIds);
  const idGenerico = contaInfo.produto_generico_id || null;

  let temNaoMapeado = false;
  const itens = itensRaw.map(i => {
    const map = mapMap[i.marketplace_anuncio_id];
    const mapeado = map?.status_mapeamento === 'mapeado' && map?.produto_id;
    if (!mapeado) temNaoMapeado = true;
    return {
      ...i,
      produto_id:                 mapeado ? map.produto_id  : (idGenerico || null),
      produto_nome:               mapeado ? map.produto_nome : (i.produto_nome || 'Produto sem mapeamento'),
      produto_sku:                mapeado ? (map.produto_sku || '') : (i.sku_marketplace || 'GENERICO'),
      nao_mapeado:                !mapeado,
      produto_original_descricao: i.produto_nome || i.produto_original_descricao || '',
    };
  });

  const statusBase = temNaoMapeado ? 'bloqueado_mapeamento' : _statusBase44(pedido.status_shopee);

  return {
    empresa_id:              contaInfo.empresa_id   || null,
    empresa_nome:            contaInfo.empresa_nome  || null,
    pedido_id:               pedido.pedido_id,
    data_pedido_marketplace: pedido.data_pedido     || null,
    cliente_nome:            pedido.cliente_nome    || 'Cliente Shopee',
    cliente_telefone:        pedido.cliente_telefone || null,
    endereco_entrega:        pedido.endereco_entrega || null,
    cliente_cidade:          pedido.cliente_cidade  || null,
    cliente_estado:          pedido.cliente_estado  || null,
    origem_canal:            'marketplace',
    marketplace_config_id:   contaInfo.marketplace_config_id || contaInfo.id,
    marketplace_plataforma:  pedido.canal || 'shopee',
    marketplace_conta_nome:  contaInfo.nome         || null,
    status:                  statusBase,
    tem_bloqueio:            temNaoMapeado,
    motivo_bloqueio:         temNaoMapeado ? 'Anúncio(s) sem mapeamento de produto. Mapear em Gestão de Anúncios.' : null,
    estoque_baixado:         false,
    status_ml:               pedido.status_shopee   || null,
    status_pagamento:        pedido.status_pagamento || null,
    valor_total:             pedido.valor_total      || 0,
    valor_produtos:          pedido.valor_produtos   || 0,
    valor_frete_cliente:     pedido.valor_frete      || 0,
    valor_desconto:          pedido.valor_desconto   || 0,
    transportadora:          pedido.transportadora   || null,
    metodo_envio:            pedido.metodo_envio     || null,
    codigo_rastreio:         pedido.codigo_rastreio  || null,
    shipping_id:             pedido.shipping_id      || null,
    data_prazo_envio:        pedido.data_prazo_envio || null,
    itens:                   itens,
    ultima_sincronizacao:    new Date().toISOString(),
  };
}

function _statusBase44(statusShopee) {
  return { UNPAID:'emitir', READY_TO_SHIP:'emitir', PROCESSED:'em_separacao', SHIPPED:'enviado', COMPLETED:'finalizado', CANCELLED:'cancelado', IN_CANCEL:'cancelado' }[statusShopee] || 'emitir';
}

async function criarSeparacao(pedido, contaInfo) {
  return post('/entities/Separacao', _separacaoPayload(pedido, contaInfo));
}

async function atualizarSeparacao(base44Id, pedido, contaInfo) {
  return put(`/entities/Separacao/${base44Id}`, _separacaoPayload(pedido, contaInfo));
}

// Busca separação existente pelo pedido_id
async function buscarSeparacaoPorPedidoId(pedidoId) {
  try {
    const res = await get('/entities/Separacao', { pedido_id: pedidoId, limit: 1 });
    const list = Array.isArray(res) ? res : (res.results || []);
    return list[0] || null;
  } catch { return null; }
}

// Atualiza mapeamento de produto no Anuncio do Base44
async function mapearAnuncioBase44(base44AnuncioId, produtoId, produtoNome, produtoSku, mapeadoPor) {
  if (!base44AnuncioId) return null;
  return put(`/entities/Anuncio/${base44AnuncioId}`, {
    produto_id: produtoId,
    produto_nome: produtoNome,
    produto_sku: produtoSku || null,
    status_mapeamento: 'mapeado',
    mapeado_por: mapeadoPor || 'PDV',
    mapeado_em: new Date().toISOString(),
  });
}

// Busca ou cria o produto genérico para pedidos sem mapeamento
async function getIdProdutoGenerico(empresaId) {
  try {
    const res = await get('/entities/Produto', { empresa_id: empresaId, tipo: 'generico', limit: 1 });
    const list = Array.isArray(res) ? res : (res.results || []);
    if (list[0]) return list[0]._id || list[0].id;
  } catch {}
  return null;
}

async function enviarPedidoBase44(pedidoLocal, contaInfo) {
  // Verifica se já existe no Base44
  const existente = pedidoLocal.base44_id
    ? { _id: pedidoLocal.base44_id }
    : await buscarSeparacaoPorPedidoId(pedidoLocal.pedido_id);

  if (existente?._id) {
    return atualizarSeparacao(existente._id, pedidoLocal, contaInfo);
  }
  return criarSeparacao(pedidoLocal, contaInfo);
}

// ─── Anúncios Marketplace ─────────────────────────────────────────────

// Converte registro do SQLite local para payload Base44
function _anuncioPayload(local, contaInfo) {
  const statusMap = { NORMAL: 'ativo', UNLIST: 'pausado', BANNED: 'deletado', DELETED: 'deletado' };
  return {
    empresa_id:               contaInfo.empresa_id   || null,
    empresa_nome:             contaInfo.empresa_nome  || null,
    marketplace_config_id:    contaInfo.marketplace_config_id || contaInfo.id,
    marketplace_plataforma:   local.canal || 'shopee',
    marketplace_seller_id:    contaInfo.shop_id      || null,
    marketplace_anuncio_id:   local.item_id,
    titulo:                   local.nome             || '(sem título)',
    preco_marketplace:        local.preco            || null,
    preco_local:              local.preco            || null,
    estoque_marketplace:      local.estoque          || 0,
    estoque_sistema:          local.estoque          || 0,
    thumbnail_url:            local.imagem_url       || null,
    status:                   statusMap[local.status] || 'ativo',
    status_marketplace:       local.status           || 'NORMAL',
    status_mapeamento:        'pendente_mapeamento',
    status_sincronizacao:     'sincronizado',
    vendas_quantidade:        local.vendas           || 0,
    data_importacao:          local.criado_em        || new Date().toISOString(),
    ultima_sincronizacao:     local.sincronizado_em  || new Date().toISOString(),
  };
}

// Busca anúncios já existentes no Base44 para esta conta (evita duplicatas)
async function listarAnunciosRemoto(marketplaceConfigId) {
  const items = [];
  let skip = 0;
  while (true) {
    const res = await get('/entities/Anuncio', {
      marketplace_config_id: marketplaceConfigId,
      limit: 200, skip,
    });
    const batch = Array.isArray(res) ? res : (res.results || []);
    items.push(...batch);
    if (batch.length < 200) break;
    skip += 200;
  }
  return items;
}

async function upsertAnuncio(local, contaInfo, remoteId) {
  const payload = _anuncioPayload(local, contaInfo);
  if (remoteId) return put(`/entities/Anuncio/${remoteId}`, payload);
  return post('/entities/Anuncio', payload);
}

// Envia todos os anúncios locais para Base44, sem duplicar
async function sincronizarAnunciosBase44(contaInfo, anunciosLocais, onProgress) {
  const db = require('./database');
  const remotos = await listarAnunciosRemoto(contaInfo.marketplace_config_id || contaInfo.id);
  const remotoMap = {};
  for (const r of remotos) remotoMap[r.marketplace_anuncio_id] = r._id || r.id;

  let n = 0, erros = 0;
  for (const local of anunciosLocais) {
    try {
      const res = await upsertAnuncio(local, contaInfo, remotoMap[local.item_id]);
      const b44id = res?._id || res?.id;
      if (b44id) db.mktAnuncios.salvarBase44Id(contaInfo.id || local.conta_id, local.item_id, b44id);
      n++;
    } catch(e) {
      console.warn('[Anuncio] Erro ao enviar', local.item_id, e.message);
      erros++;
    }
    if (onProgress) onProgress(n, anunciosLocais.length, erros);
  }
  return { enviados: n, erros, total: anunciosLocais.length };
}

async function repararClienteNasVendas(db, onProgresso) {
  // Abordagem: busca clientes locais com remote_id, depois corrige no Base44
  // todas as ContaReceber desse cliente que estão com cliente_nome errado.
  // Isso funciona mesmo quando as vendas locais não têm cliente_id preenchido.
  const clientes = db.db().prepare(`
    SELECT remote_id, nome FROM clientes WHERE remote_id IS NOT NULL AND nome IS NOT NULL
  `).all();

  let corrigidas = 0;
  let total = 0;
  const erros = [];

  for (let ci = 0; ci < clientes.length; ci++) {
    const cli = clientes[ci];
    try {
      // Busca TODAS as ContaReceber deste cliente no Base44
      const limit = 200;
      let skip = 0;
      const contasDoCli = [];
      while (true) {
        const res = await get('/entities/ContaReceber', {
          q: JSON.stringify({ cliente_id: cli.remote_id }),
          limit, skip,
        });
        const items = Array.isArray(res) ? res : (res.results || []);
        contasDoCli.push(...items);
        if (items.length < limit) break;
        skip += items.length;
      }

      total += contasDoCli.length;

      // Corrige as que têm cliente_nome errado (null, vazio ou "Cliente")
      for (const conta of contasDoCli) {
        const nomeErrado = !conta.cliente_nome || conta.cliente_nome.trim() === '' || conta.cliente_nome === 'Cliente';
        if (!nomeErrado) continue;
        try {
          await put(`/entities/ContaReceber/${conta.id}`, { cliente_nome: cli.nome });
          corrigidas++;
          if (onProgresso) onProgresso(corrigidas, total, conta.descricao || conta.id, cli.nome);
        } catch (e) {
          erros.push({ conta: conta.id, erro: e.message });
        }
      }

      // Também corrige as Vendas com cliente_nome errado
      const vendasDoCli = [];
      skip = 0;
      while (true) {
        const res = await get('/entities/Venda', {
          q: JSON.stringify({ cliente_id: cli.remote_id }),
          limit, skip,
        });
        const items = Array.isArray(res) ? res : (res.results || []);
        vendasDoCli.push(...items);
        if (items.length < limit) break;
        skip += items.length;
      }

      for (const venda of vendasDoCli) {
        const nomeErrado = !venda.cliente_nome || venda.cliente_nome.trim() === '' || venda.cliente_nome === 'Cliente';
        if (!nomeErrado) continue;
        try {
          await put(`/entities/Venda/${venda.id}`, { cliente_nome: cli.nome });
          corrigidas++;
          if (onProgresso) onProgresso(corrigidas, total, `Venda #${venda.numero}`, cli.nome);
        } catch (e) {
          erros.push({ venda: venda.numero, erro: e.message });
        }
      }
    } catch (e) {
      erros.push({ cliente: cli.nome, erro: e.message });
    }
  }

  return { total, corrigidas, erros };
}

module.exports = {
  registrarFalta,
  atualizarFalta,
  listarFaltasRemoto,
  ping, post,
  sincronizarProdutos,
  registrarCliente,
  atualizarCliente,
  atualizarClienteEndereco,
  sincronizarClientes,
  autenticarPDV,
  sincronizarConfigDesconto,
  sincronizarConfigTermometro,
  sincronizarEstoque,
  sincronizarVendedores,
  sincronizarCreditosCliente,
  getCreditosDoCliente,
  receberCreditoCliente,
  sincronizarContasReceber,
  pagarContaReceber,
  pagarContaReceberParcial,
  usarCreditoEmConta,
  registrarVenda,
  editarVenda,
  cancelarVenda,
  listarVendasCloud,
  getProduto,
  registrarEntrega,
  listarEntregasRemoto,
  atualizarEntrega,
  atualizarProduto,
  listarAnunciosRemoto,
  upsertAnuncio,
  sincronizarAnunciosBase44,
  enviarPedidoBase44,
  criarSeparacao,
  atualizarSeparacao,
  mapearAnuncioBase44,
  getIdProdutoGenerico,
  sincronizarOrcamento,
  atualizarStatusOrcamento,
  listarOrcamentosCloud,
  getOrcamentoCloud,
  registrarNfceVenda,
  chamarPdvProxy,
  repararClienteNasVendas,
};

// ─── pdvProxy — gateway server-side (WhatsApp, etc.) ────────────────────────
async function chamarPdvProxy(action, params) {
  const pdvUserId = store.get('auth.token');
  if (!pdvUserId) throw new Error('Usuário não autenticado');
  const url = 'https://sistemavargas.com.br/functions/pdvProxy';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': API_KEY },
    body: JSON.stringify({ pdv_user_id: pdvUserId, action, params }),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Servidor retornou resposta inválida: ${text.slice(0, 200)}`); }
  console.log('[pdvProxy] resposta:', JSON.stringify(json));
  if (!json.sucesso) throw new Error(json.erro || json.error || json.message || `HTTP ${res.status}: ${text.slice(0, 200)}`);
  return json.dados;
}

// ─── NFC-e — Sincronizar resultado para Base44 ────────────────────────────────
async function registrarNfceVenda(vendaRemoteId, dados) {
  if (!vendaRemoteId) throw new Error('vendaRemoteId obrigatório');
  return put(`/entities/Venda/${vendaRemoteId}`, {
    nfce_emitida: true,
    nfce_chave:         dados.chave || '',
    nfce_numero:        String(dados.numero || ''),
    nfce_serie:         String(dados.serie || ''),
    nfce_status:        dados.status || 'autorizado',
    nfce_status_sefaz:  dados.status_sefaz  ? String(dados.status_sefaz)  : '',
    nfce_motivo_sefaz:  dados.motivo_sefaz  || '',
    nfce_url_xml:       dados.url_xml        || '',
    nfce_url_pdf:       dados.danfe_url || dados.url_danfe_nfce || dados.url_pdf || '',
    nfce_dados:         dados,
  });
}

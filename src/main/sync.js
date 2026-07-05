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

    // 1. Upload primeiro: enviar alterações locais antes de sobrescrever com download
    await syncUpProdutos();
    await recuperarClientesPendentes();
    await processarFilaSync();
    await recuperarVendasPendentes();

    // 2. Baixar dados do servidor (servidor → local) — agora o Base44 já tem os dados locais
    await syncDownProdutos();
    await syncDownClientes();
    await syncDownEstoque();
    await syncDownVendedores();
    await syncDownCreditosCliente();
    await syncDownContasReceber();
    await syncDownConfigDesconto();
    await syncDownConfigTermometro();
    await syncDownFaltas();

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

// Mapeia campos do Base44 → schema local SQLite
function mapProduto(p) {
  return {
    id:          p.id,
    nome:        p.nome,
    sku:         p.sku         || null,
    ean:         p.ean         || null,
    preco_venda: p.preco_venda || 0,
    preco_custo: p.custo       || 0,
    unidade:     p.unidade     || 'UN',
    categoria:   p.categoria   || null,
    marca:       p.marca       || null,
    foto_url:    p.imagem_url  || null,
    ativo:          p.ativo !== false,
    disponivel_pdv: p.disponivel_pdv !== false,
    permite_fracao: p.unidade === 'KG' || p.unidade === 'LT' || p.unidade === 'MT',
    updated_at:     p.updated_date || new Date().toISOString(),
    estoque:        p.estoque      || 0,
    estoque_minimo: p.estoque_minimo || 0,
    // Campos fiscais do Base44
    ncm:       p.ncm       || null,
    cfop:      p.cfop      || null,
    icms_cst:  p.csosn     || p.cst_icms || null,
    icms_origem: parseInt(p.origem) || 0,
    pis_cst:   p.cst_pis   || null,
    cofins_cst:p.cst_cofins|| null,
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
    updated_at:       c.updated_date    || new Date().toISOString(),
  };
}

async function syncDownProdutos() {
  const ultimaSync = store.get('sync.ultima_sync_produtos') || null;
  const incremental = !!ultimaSync;

  emitir(mainWindowRef, 'sync:update', {
    ...syncStatus,
    progresso: incremental ? 'Verificando atualizações de produtos...' : 'Baixando catálogo completo...'
  });

  let totalSalvos = 0;

  await api.sincronizarProdutos(ultimaSync, (lote, total) => {
    db.produtos.upsertBatch(lote.map(mapProduto));
    totalSalvos = total;
    if (total % 500 === 0 || lote.length < 200) {
      emitir(mainWindowRef, 'sync:update', { ...syncStatus, progresso: `Produtos: ${total} atualizados...` });
    }
  });

  if (totalSalvos > 0 || !ultimaSync) {
    store.set('sync.ultima_sync_produtos', new Date().toISOString());
    console.log(`[SYNC] Produtos: ${totalSalvos} ${incremental ? 'atualizados' : 'sincronizados'}`);
  } else {
    console.log('[SYNC] Produtos: nenhuma atualização desde', ultimaSync);
  }
}

async function syncDownClientes() {
  const ultimaSync = store.get('sync.ultima_sync_clientes');
  emitir(mainWindowRef, 'sync:update', { ...syncStatus, progresso: 'Sincronizando clientes...' });

  const clientes = await api.sincronizarClientes(ultimaSync);
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
      db.vendedores.upsertBatch(vendedores);
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

async function syncDownConfigTermometro() {
  try {
    const cfg = await api.sincronizarConfigTermometro();
    if (cfg) {
      store.set('config_termometro', {
        margem_excelente: cfg.margem_excelente ?? 30,
        margem_boa:       cfg.margem_boa       ?? 15,
        margem_media:     cfg.margem_media      ?? 8,
      });
      console.log('[SYNC] ConfigTermometro sincronizado');
    }
  } catch (err) {
    console.warn('[SYNC] ConfigTermometro: erro (não crítico):', err.message);
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
          const venda = db.vendas.getById(payload.venda_id);
          if (venda && venda.status !== 'cancelada') {
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
                } catch {}
              } else if (cli?.remote_id) {
                venda.cliente_remote_id = cli.remote_id;
              }
            }
            const res = await api.registrarVenda(venda);
            // Salvar remote_id retornado pelo servidor
            if (res?.id) {
              db.db().prepare('UPDATE vendas SET remote_id = ?, sync_status = ?, synced_at = ? WHERE id = ?')
                .run(res.id, 'synced', new Date().toISOString(), payload.venda_id);
            }
          }
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
        }
      }

      if (item.entidade === 'estoque') {
        const mov = db.db().prepare('SELECT * FROM movimentacoes_estoque WHERE id = ?').get(payload.mov_id);
        if (mov) {
          await api.enviarMovimentacaoEstoque(mov);
          db.db().prepare("UPDATE movimentacoes_estoque SET sync_status = 'synced' WHERE id = ?").run(mov.id);
        }
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
    } catch (err) {
      console.error(`[SYNC] Falha ao recuperar venda ${id}:`, err.message);
    }
  }
}

// ─── Upload: produtos alterados localmente → Base44 ──────────────
async function syncUpProdutos() {
  const pendentes = db.db().prepare(`
    SELECT id, remote_id, nome, ncm, cfop, icms_cst, icms_origem,
           pis_cst, cofins_cst, disponivel_pdv, preco_venda, preco_custo,
           categoria, marca, unidade
    FROM produtos
    WHERE sync_status = 'pending' AND remote_id IS NOT NULL
    LIMIT 100
  `).all();

  if (!pendentes.length) return;

  console.log(`[SYNC] Produtos: enviando ${pendentes.length} alterações para o Base44`);
  const now = new Date().toISOString();
  let ok = 0;

  for (const p of pendentes) {
    try {
      await api.atualizarProduto(p.remote_id, p);
      db.db().prepare(`UPDATE produtos SET sync_status = 'synced', synced_at = ? WHERE id = ?`)
        .run(now, p.id);
      ok++;
    } catch(err) {
      console.error(`[SYNC] Produto "${p.nome}" erro:`, err.message);
      db.db().prepare(`UPDATE produtos SET sync_status = 'error' WHERE id = ?`).run(p.id);
    }
  }
  if (ok) console.log(`[SYNC] Produtos: ${ok} atualizados no Base44`);
}

// ─── Sync leve: só envia a fila pendente (usado após cada venda) ──
async function syncFila(win) {
  if (isSyncing) return; // sync completo já em andamento, não duplicar
  mainWindowRef = win || mainWindowRef;

  const online = await api.ping();
  if (!online) return;

  try {
    await recuperarClientesPendentes();
    await processarFilaSync();
    await syncUpProdutos();
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
  // Re-sync completo de clientes + créditos, sem lock isSyncing
  const clientes = await api.sincronizarClientes(null);
  if (clientes.length > 0) db.clientes.upsertBatch(clientes.map(mapCliente));

  const creditos = await api.sincronizarCreditosCliente();
  if (creditos.length > 0) db.creditosCliente.upsertBatch(creditos);

  const contas = await api.sincronizarContasReceber();
  if (contas.length > 0) db.contasReceber.upsertBatch(contas);

  console.log(`[SYNC] Carteira forçada: ${clientes.length} clientes, ${creditos.length} créditos, ${contas.length} contas`);
  return { clientes: clientes.length, creditos: creditos.length, contas: contas.length };
}

module.exports = { startAutoSync, stopAutoSync, syncNow, syncFila, getStatus, checkOnline, syncUpProdutos, syncForcarClientes, syncForcarCarteira };

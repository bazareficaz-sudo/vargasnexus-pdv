const { app, BrowserWindow, ipcMain, Menu, Tray, dialog, nativeTheme, shell } = require('electron');
const path = require('path');
const Store = require('electron-store');

const store = new Store();
let mainWindow;
let tray;

// ─── Imports internos ───────────────────────────────────────────
const db = require('./database');
const sync = require('./sync');
const api = require('./api');
const printServer = require('./print-server');
const tunnel = require('./tunnel');
const updater = require('./updater');
const focusnfe = require('./focusnfe');
const ia       = require('./ia');
const shopee   = require('./shopee');
const tiktok   = require('./tiktok');

// Roteador: retorna o módulo certo conforme o canal da conta
function _mkt(contaId) {
  const conta = shopee.getConta(contaId) || tiktok.getConta(contaId);
  if (!conta) return shopee; // fallback
  return conta.canal === 'tiktok' ? tiktok : shopee;
}

nativeTheme.themeSource = 'dark';

// ─── Criar janela principal ──────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    // Migrar campos empresa_fiscal_id/empresa_estoque_id de permissoes para o usuário
    _migrarEmpresasUsuario();
    _iniciarPollingPedidos();
    sync.startAutoSync(mainWindow);
    // Auto-iniciar servidor de impressão se configurado como CAIXA
    if (store.get('config.print_server_ativo') === true) {
      const porta = store.get('config.print_server_porta') || 3001;
      printServer.start(porta);
    }
    // Atualização automática (só em produção — não no dev)
    if (app.isPackaged) {
      updater.init(mainWindow);
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── Migrar campos de empresa do usuário logado ─────────────────
function _migrarEmpresasUsuario() {
  const usuario = store.get('auth.usuario');
  if (!usuario) return;
  const perms = usuario.permissoes || {};
  let alterado = false;

  if (!usuario.empresa_fiscal_id && perms.empresa_emissao_fiscal_id) {
    usuario.empresa_fiscal_id = perms.empresa_emissao_fiscal_id;
    alterado = true;
  }
  if (!usuario.empresa_estoque_id && perms.estoque_empresa_id) {
    usuario.empresa_estoque_id = perms.estoque_empresa_id;
    alterado = true;
  }
  if (!usuario.deposito_id && perms.estoque_deposito_id) {
    usuario.deposito_id = perms.estoque_deposito_id;
    alterado = true;
  }
  if (!usuario.unificar_estoque && perms.unificar_estoque) {
    usuario.unificar_estoque = perms.unificar_estoque;
    alterado = true;
  }

  if (alterado) {
    store.set('auth.usuario', usuario);
    console.log('[AUTH] Empresas migradas de permissoes:',
      'fiscal:', usuario.empresa_fiscal_id,
      'estoque:', usuario.empresa_estoque_id,
      'deposito:', usuario.deposito_id);
  }
}

// ─── System Tray ────────────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, '../../assets/icon.png');
  const fs = require('fs');
  if (!fs.existsSync(iconPath)) return;
  tray = new Tray(iconPath);
  const menu = Menu.buildFromTemplate([
    { label: 'VargasNexus PDV', enabled: false },
    { type: 'separator' },
    { label: 'Abrir PDV', click: () => mainWindow?.show() },
    { label: 'Sincronizar agora', click: () => sync.syncNow(mainWindow) },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() }
  ]);
  tray.setToolTip('VargasNexus PDV');
  tray.setContextMenu(menu);
  tray.on('double-click', () => mainWindow?.show());
}

// ─── App lifecycle ───────────────────────────────────────────────
// ─── Deep Link: protocolo vargas:// ──────────────────────────────
const GOT_LOCK = app.requestSingleInstanceLock();
if (!GOT_LOCK) { app.quit(); }

// Em modo dev (electron . ) precisa passar o script como argumento extra
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient('vargas', process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient('vargas');
}

function handleDeepLink(url) {
  if (!url || !url.startsWith('vargas://shopee-auth')) return;
  try {
    const u      = new URL(url);
    const code   = u.searchParams.get('code');
    const shopId = u.searchParams.get('shop_id');
    if (code && shopId) shopee.receberCallback(code, shopId);
  } catch (e) { console.error('[DeepLink] Erro:', e.message); }
}

app.on('second-instance', (_, argv) => {
  const deepUrl = argv.find(a => a.startsWith('vargas://'));
  if (deepUrl) handleDeepLink(deepUrl);
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

app.on('open-url', (_, url) => handleDeepLink(url)); // macOS

app.whenReady().then(() => {
  db.initialize();
  createWindow();
  createTray();
  // Captura deep link se o app foi aberto pelo protocolo vargas://
  const deepUrl = process.argv.find(a => a.startsWith('vargas://'));
  if (deepUrl) setTimeout(() => handleDeepLink(deepUrl), 2000);
  app.on('activate', () => { if (!mainWindow) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC Handlers ────────────────────────────────────────────────

// Config / Auth
ipcMain.handle('config:get', (_, key) => store.get(key));
ipcMain.handle('config:set', (_, key, val) => store.set(key, val));
ipcMain.handle('config:getAll', () => store.store);

// Sugestões
ipcMain.handle('sugestoes:porCarrinho', (_, ids) => db.sugestoes.porCarrinho(ids));
ipcMain.handle('sugestoes:porCliente', (_, clienteId, ids) => db.sugestoes.porCliente(clienteId, ids));
ipcMain.handle('sugestoes:maisVendidos', (_, ids) => db.sugestoes.maisVendidos(ids));

// Produtos
ipcMain.handle('produtos:buscar', (_, query) => db.produtos.buscar(query));
ipcMain.handle('produtos:buscarGestao', (_, query) => db.produtos.buscarGestao(query));
ipcMain.handle('produtos:getById', (_, id) => db.produtos.getById(id));
ipcMain.handle('produtos:getByEan', (_, ean) => db.produtos.getByEan(ean));
ipcMain.handle('produtos:total', () => db.produtos.total());
ipcMain.handle('produtos:salvar', (_, produto) => db.produtos.salvar(produto));
ipcMain.handle('produtos:atualizar', (_, id, dados) => db.produtos.atualizar(id, dados));

// Clientes
ipcMain.handle('clientes:buscar', (_, query) => db.clientes.buscar(query));
ipcMain.handle('clientes:getById', (_, id) => db.clientes.getById(id));
ipcMain.handle('clientes:salvar', (_, cliente) => db.clientes.salvar(cliente));
ipcMain.handle('clientes:credito', (_, clienteId) => db.clientes.getCredito(clienteId));
ipcMain.handle('clientes:syncForcar', async () => {
  try {
    return await sync.syncForcarClientes();
  } catch(e) {
    return { erro: e.message };
  }
});
ipcMain.handle('clientes:atualizarEndereco', async (_, remoteId, dados) => {
  try {
    // Atualiza local
    db.clientes.atualizarEndereco(remoteId, dados);
    // Atualiza no Base44
    const res = await api.atualizarClienteEndereco(remoteId, dados);
    return { ok: true, res };
  } catch(e) {
    return { erro: e.message };
  }
});

// Vendedores
ipcMain.handle('vendedores:getByCodigo', (_, codigo) => db.vendedores.getByCodigo(codigo));
ipcMain.handle('vendedores:listar', () => db.vendedores.listar());

// Créditos Cliente (Contas a Receber)
ipcMain.handle('creditos:getAbertos', (_, clienteRemoteId) =>
  db.creditosCliente.getAbertosDoCliente(clienteRemoteId)
);
ipcMain.handle('creditos:resumo', (_, clienteRemoteId) =>
  db.creditosCliente.resumoPorCliente(clienteRemoteId)
);
ipcMain.handle('creditos:criar', async (_, clienteRemoteId, clienteNome, clienteTelefone, valor, observacao) => {
  const usuario = store.get('auth.usuario') || {};
  const payload = {
    empresa_id: usuario.empresa_estoque_id || usuario.empresa_id || store.get('auth.empresa_id'),
    cliente_id: clienteRemoteId,
    cliente_nome: clienteNome || null,
    cliente_telefone: clienteTelefone || null,
    valor_original: valor,
    saldo_atual: valor,
    status: 'aberto',
    origem: 'devolucao',
    operador_nome: usuario.nome || null,
    observacao: observacao || null,
  };
  try {
    const res = await api.criarCreditoCliente(payload);
    if (res?.id) db.creditosCliente.upsertBatch([{ ...payload, id: res.id }]);
    return res;
  } catch (err) {
    console.error('[CREDITO] Erro ao criar crédito de devolução:', err.message);
    // Salva local mesmo se Supabase falhar
    db.creditosCliente.upsertBatch([{ ...payload, id: require('uuid').v4() }]);
  }
});

ipcMain.handle('creditos:receber', async (_, remoteId, valorPago, saldoAtual, observacao) => {
  const novoSaldo = Math.max(0, saldoAtual - valorPago);
  const novoStatus = novoSaldo <= 0 ? 'usado_totalmente' : 'usado_parcialmente';
  // Atualizar local imediatamente
  db.creditosCliente.atualizarSaldo(remoteId, novoSaldo, novoStatus);
  // Sincronizar com Base44
  try {
    await api.receberCreditoCliente(remoteId, novoSaldo, novoStatus, observacao);
  } catch (err) {
    console.error('[CREDITO] Erro ao sincronizar recebimento:', err.message);
  }
  return { novoSaldo, novoStatus };
});

// Vendas
ipcMain.handle('vendas:registrar', (_, venda) => {
  const terminalId = store.get('config.terminal_id') || '';
  const match = terminalId.match(/(\d+)$/);
  const terminalNum = match ? parseInt(match[1], 10) : 0;
  venda._numero_base = terminalNum * 100000; // PDV-001 → 100000, PDV-002 → 200000
  const result = db.vendas.registrar(venda);
  // Enviar só a fila — sem re-baixar catálogo inteiro
  setImmediate(() => sync.syncFila(mainWindow));
  return result;
});
ipcMain.handle('vendas:listar', (_, filtros) => db.vendas.listar(filtros));
ipcMain.handle('vendas:getById', (_, id) => db.vendas.getById(id));
ipcMain.handle('vendas:cancelar', (_, id, motivo) => db.vendas.cancelar(id, motivo));
ipcMain.handle('vendas:editar', async (_, id, novosItens, novosDados) => {
  const vendaAtualizada = db.vendas.editar(id, novosItens, novosDados);
  // Re-sincronizar com Base44 se tiver remote_id
  if (vendaAtualizada?.remote_id) {
    try {
      await api.editarVenda(vendaAtualizada.remote_id, vendaAtualizada.itens, novosDados, novosDados.forma_pagamento);
    } catch (err) {
      console.warn('[VENDA] Erro ao sincronizar edição:', err.message);
    }
  }
  setImmediate(() => sync.syncFila(mainWindow));
  return vendaAtualizada;
});
ipcMain.handle('vendas:totaisHoje', () => db.vendas.totaisHoje());
ipcMain.handle('vendas:listarCloud', (_, data) => api.listarVendasCloud(data));

// Orçamentos
ipcMain.handle('orcamentos:registrar', async (_, orc) => {
  const result = db.orcamentos.registrar(orc);
  // Tenta enviar já — se falhar (offline, etc.), a fila de sync (sync_queue,
  // enfileirada por db.orcamentos.registrar) garante o reenvio automático
  // quando a conexão voltar.
  setImmediate(async () => {
    try {
      const payload = db.orcamentos.payloadSync(result.id);
      const res = await api.sincronizarOrcamento(sync.montarPayloadOrcamentoRemoto(payload));
      if (res?.id || res?._id) db.orcamentos.atualizarRemoteId(result.id, res.id || res._id);
    } catch (err) {
      console.warn('[ORC] Sync imediato falhou, será reenviado pela fila:', err.message);
    }
  });
  return result;
});
ipcMain.handle('orcamentos:listar', (_, filtros) => db.orcamentos.listar(filtros));
ipcMain.handle('orcamentos:listarCloud', async (_, filtros) => {
  try { return await api.listarOrcamentosCloud(filtros); } catch(e) { return []; }
});
ipcMain.handle('orcamentos:getByIdCloud', async (_, remoteId) => {
  try { return await api.getOrcamentoCloud(remoteId); } catch(e) { return null; }
});
ipcMain.handle('orcamentos:getById', (_, id) => db.orcamentos.getById(id));
ipcMain.handle('orcamentos:cancelar', async (_, id) => {
  db.orcamentos.cancelar(id);
  const orc = db.orcamentos.getById(id);
  if (orc?.remote_id) {
    try { await api.atualizarStatusOrcamento(orc.remote_id, 'cancelado'); } catch {}
  }
  return { ok: true };
});
ipcMain.handle('orcamentos:marcarConvertido', async (_, id) => {
  db.orcamentos.marcarConvertido(id);
  const orc = db.orcamentos.getById(id);
  if (orc?.remote_id) {
    try { await api.atualizarStatusOrcamento(orc.remote_id, 'convertido'); } catch {}
  }
  return { ok: true };
});
ipcMain.handle('orcamentos:atualizar', async (_, id, dados) => {
  db.orcamentos.atualizar(id, dados);
  const orc = db.orcamentos.getById(id);
  if (orc?.remote_id) {
    try {
      await api.atualizarOrcamento(orc.remote_id, {
        cliente_id: dados.cliente_id, cliente_nome: dados.cliente_nome,
        cliente_telefone: dados.cliente_telefone, forma_pagamento: dados.forma_pagamento,
        validade_dias: dados.validade_dias, subtotal: dados.subtotal,
        desconto: dados.desconto, total: dados.total, observacao: dados.observacao,
        itens: dados.itens,
      });
    } catch(e) { console.warn('[ORC] Erro ao atualizar cloud:', e.message); }
  }
  return { ok: true };
});

// WhatsApp via pdvProxy
ipcMain.handle('whatsapp:enviar', async (_, tipo, id, telefone, dadosExtras) => {
  const params = { tipo: tipo === 'catalogo' ? 'orcamento' : tipo, telefone: telefone || null };
  if (tipo === 'catalogo') {
    const { produtos, opcoes } = dadosExtras || {};
    if (!produtos || !produtos.length) throw new Error('Nenhum produto para enviar');
    const fmtBRL = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
    const empresaNome = store.get('auth.usuario.empresa_nome') || 'Vargas';

    const comFoto = [];
    const semFotoLinhas = [];

    for (const p of produtos) {
      const partes = [];
      if (opcoes?.nome  !== false) partes.push(`*${p.nome}*`);
      if (opcoes?.preco !== false) partes.push(fmtBRL(p.preco_venda || 0));
      if (opcoes?.desc  && p.descricao) partes.push(p.descricao);
      const legenda = partes.join('\n');
      const fotoUrl = opcoes?.foto !== false ? (p.foto_url || '') : '';
      if (fotoUrl) {
        comFoto.push({ url: fotoUrl, caption: legenda });
      } else {
        semFotoLinhas.push(legenda);
      }
    }

    // Texto apenas para produtos sem foto (ou intro se todos têm foto)
    params.mensagem_texto = semFotoLinhas.length
      ? `🏪 *${empresaNome}*\n\n` + semFotoLinhas.join('\n─────────────\n\n')
      : `🏪 *${empresaNome}*`;
    if (comFoto.length) params.fotos = comFoto;
    // orcamento_data mínimo para passar validação do cloud (mensagem_texto substitui o conteúdo)
    params.orcamento_data = { numero: 'CAT', itens: [], total: 0 };
    console.log('[WA] catalogo fotos:', comFoto.length, '| semFoto:', semFotoLinhas.length);
  } else if (tipo === 'orcamento') {
    const orc = db.orcamentos.getById(id);
    if (!orc) throw new Error('Orçamento não encontrado');
    const itensOrc = Array.isArray(orc.itens) ? orc.itens : [];
    // Gera mensagem de texto localmente (evita dependência do gerarMensagemOrcamento do Base44)
    const fmtBRL = v => 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
    const empresaNome = store.get('auth.usuario.empresa_nome') || 'Vargas';
    let linhasItens = itensOrc.map(i => {
      const unitario = i.preco_unitario || i.preco || i.preco_venda || i.valor_unitario
                       || (i.total && i.quantidade ? i.total / Math.max(i.quantidade, 1) : 0);
      const subtotal = i.subtotal || i.total || (unitario * Math.max(i.quantidade || 1, 1));
      return `• ${i.produto_nome}\n  ${i.quantidade}x ${fmtBRL(unitario)} = ${fmtBRL(subtotal)}`;
    }).join('\n');
    const totalOrc = orc.total || orc.valor_total || itensOrc.reduce((s, i) => s + (i.subtotal || i.total || 0), 0);
    const validadeTexto = orc.validade ? `\n📅 Válido até: ${orc.validade}` : '';
    const obsTexto = orc.observacao ? `\n📝 ${orc.observacao}` : '';
    // Enviar orcamento_data sem o id para o cloud não buscar no Base44
    // (no Base44 os itens têm preco_unitario=0; aqui temos os preços corretos do SQLite)
    const itensNormalizados = itensOrc.map(i => {
      const unitario = i.preco_unitario || i.preco || i.preco_venda || i.valor_unitario
                       || (i.total && i.quantidade ? i.total / Math.max(i.quantidade, 1) : 0);
      return { produto_nome: i.produto_nome, quantidade: i.quantidade, preco_unitario: unitario,
               subtotal: i.subtotal || i.total || (unitario * Math.max(i.quantidade || 1, 1)) };
    });
    params.orcamento_data = {
      numero: orc.numero, itens: itensNormalizados,
      total: totalOrc, validade: orc.validade, observacao: orc.observacao,
      // sem id — força o cloud a usar estes dados em vez de buscar no Base44
    };
  } else if (tipo === 'mensagem_direta') {
    // Texto livre — reutiliza o fluxo de orçamento mas com mensagem pré-formatada
    const mensagem = dadosExtras?.mensagem_texto;
    if (!mensagem) throw new Error('mensagem_texto obrigatório para mensagem_direta');
    params.tipo = 'orcamento';
    params.mensagem_texto = mensagem;
    params.orcamento_data = { numero: 'MSG', itens: [], total: 0 };
  } else {
    // dadosExtras tem prioridade (vendas de outros terminais não existem no banco local)
    const venda = dadosExtras || db.vendas.getById(id);
    if (!venda) throw new Error('Venda não encontrada');
    // Gerar PDF do cupom e incluir em base64
    try {
      const itens = typeof venda.itens === 'string' ? JSON.parse(venda.itens) : (venda.itens || []);
      const html = printServer.gerarHtmlCupom({
        numero: venda.numero, empresa_nome: store.get('auth.usuario.empresa_nome') || '',
        vendedor_nome: venda.vendedor_nome, cliente_nome: venda.cliente_nome,
        itens, subtotal: venda.subtotal || venda.total,
        desconto: venda.desconto || 0, total: venda.total,
        forma_pagamento: venda.forma_pagamento, valor_pago: venda.valor_recebido || venda.total,
        troco: venda.troco || 0, created_at: venda.created_at,
      });
      const htmlForPdf = html.replace('</head>', `<style>
        @page { size: A4; margin: 15mm 20mm; }
        body { width: 100% !important; max-width: 100% !important; font-size: 13pt !important; }
        .sm { font-size: 11pt !important; }
        .lg { font-size: 18pt !important; }
        .total-row td { font-size: 16pt !important; }
        .sep { margin: 10px 0 !important; }
        td { padding: 3px 0 !important; }
      </style></head>`);
      const tmpWin = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true } });
      await new Promise((resolve, reject) => {
        tmpWin.webContents.once('did-finish-load', resolve);
        tmpWin.webContents.once('did-fail-load', (_, code, desc) => reject(new Error(`load failed: ${desc}`)));
        tmpWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(htmlForPdf));
      });
      const pdfBuf = await tmpWin.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
      tmpWin.close();
      params.pdf_base64 = pdfBuf.toString('base64');
      params.pdf_filename = `cupom-${venda.numero}`;
      console.log('[WA] PDF gerado:', params.pdf_filename, 'bytes:', pdfBuf.length);
    } catch (e) { console.error('[WA] PDF gen error:', e.message); }
    params.venda_data = venda;

    // Após envio do cupom, verificar se tem NF-Ce e enviar após 10s
    if (venda.nfce_emitida && venda.nfce_url_pdf && params.telefone) {
      setTimeout(async () => {
        try {
          const fetch = require('node-fetch');
          const resp = await fetch(venda.nfce_url_pdf);
          if (!resp.ok) throw new Error(`NF-Ce fetch falhou: ${resp.status}`);
          const pdfBuffer = Buffer.from(await resp.arrayBuffer());
          await api.chamarPdvProxy('enviarWhatsApp', {
            tipo: 'venda',
            telefone: params.telefone,
            pdf_base64: pdfBuffer.toString('base64'),
            pdf_filename: `NFCe-${venda.nfce_numero || venda.numero}.pdf`,
            venda_data: venda,
          });
          console.log('[WA] NF-Ce PDF enviado para:', params.telefone);
        } catch (e) { console.error('[WA] NF-Ce send error:', e.message); }
      }, 10000);
    }
  }
  return api.chamarPdvProxy('enviarWhatsApp', params);
});

// Atualizar cliente em venda/orçamento
ipcMain.handle('vendas:atualizarCliente', (_, id, clienteId, nome, telefone) => {
  db.vendas.atualizarCliente(id, clienteId, nome, telefone);
  return { ok: true };
});
ipcMain.handle('orcamentos:atualizarCliente', (_, id, clienteId, nome, telefone) => {
  db.orcamentos.atualizarCliente(id, clienteId, nome, telefone);
  return { ok: true };
});

// Estoque
ipcMain.handle('estoque:get', (_, produtoId) => db.estoque.get(produtoId));
ipcMain.handle('estoque:movimentar', (_, mov) => db.estoque.movimentar(mov));
ipcMain.handle('estoque:alertas', () => db.estoque.alertas());

// Faltas
ipcMain.handle('faltas:registrar', (_, falta) => db.faltas.registrar(falta));
ipcMain.handle('faltas:listar', (_, filtros) => db.faltas.listar(filtros));
ipcMain.handle('faltas:atualizarStatus', (_, id, status) => db.faltas.atualizarStatus(id, status));
ipcMain.handle('faltas:contarPendentes', () => db.faltas.contarPendentes());

// IA
ipcMain.handle('ia:fiscal', async (_, nome, categoria, unidade) => ia.sugerirFiscal(nome, categoria, unidade));
ipcMain.handle('ia:descricao', async (_, nome, categoria, marca, unidade) => ia.gerarDescricao(nome, categoria, marca, unidade));
ipcMain.handle('ia:lote', async (_, produtos) => ia.enriquecerLote(produtos));
ipcMain.handle('ia:status', () => ({ configurado: !!ia.getApiKey() }));
ipcMain.handle('ia:buscarImagem', async (_, nome, ean) => ia.buscarImagemProduto(nome, ean));

ipcMain.handle('vendas:repararClientes', async (event) => {
  return api.repararClienteNasVendas(db, (n, total, numero, nome) => {
    event.sender.send('vendas:reparo-progresso', { n, total, numero, nome });
  });
});

// ─── Marketplace (multi-conta, multi-canal) ────────────────────────
ipcMain.handle('mkt:listarContas', (_, canal) => {
  const shopeeContas = shopee.listarContas(canal === 'tiktok' ? null : canal) || [];
  const tiktokContas = tiktok.listarContas() || [];
  const todas = [...shopeeContas, ...tiktokContas];
  return canal ? todas.filter(c => c.canal === canal) : todas;
});
ipcMain.handle('mkt:getConta',     (_, id) => shopee.getConta(id) || tiktok.getConta(id));
ipcMain.handle('mkt:salvarConta',  (_, dados) => {
  if (!dados.id) dados.id = require('crypto').randomUUID();
  return dados.canal === 'tiktok' ? tiktok.salvarConta(dados) : shopee.salvarConta(dados);
});
ipcMain.handle('mkt:removerConta', (_, id) => { shopee.removerConta(id); return { ok: true }; });
ipcMain.handle('mkt:conectar',     async (_, id) => {
  try { return { ok: true, ...( await _mkt(id).conectar(id) ) }; }
  catch(e) { return { ok: false, erro: e.message }; }
});
ipcMain.handle('mkt:desconectar',  async (_, id) => { try { await shopee.desconectar(id); } catch {} return { ok: true }; });
ipcMain.handle('mkt:shopInfo',     async (_, id) => { try { return await _mkt(id).getShopInfo(id); } catch(e) { return { erro: e.message }; } });
ipcMain.handle('mkt:anuncios',     async (_, id, page) => { try { return await shopee.getAnuncios(id, page); } catch(e) { return { erro: e.message }; } });
ipcMain.handle('mkt:pedidos',      async (_, id, status) => { try { return await shopee.getPedidos(id, status); } catch(e) { return { erro: e.message }; } });
ipcMain.handle('mkt:trocarCodigo', async (_, id, code, shopId) => {
  const conta = shopee.getConta(id) || tiktok.getConta(id);
  if (conta?.canal === 'tiktok') return tiktok.trocarCodigo(id, code);
  return shopee.trocarCodigo(id, code, shopId);
});
ipcMain.handle('mkt:anuncios:listar',   (_, contaId, busca, status, pagina) => db.mktAnuncios.listar(contaId, busca, status, pagina));
ipcMain.handle('mkt:anuncios:total',    (_, contaId)               => db.mktAnuncios.total(contaId));
ipcMain.handle('mkt:anuncios:importar', async (_, contaId) => {
  try {
    const resultado = await _mkt(contaId).importarTodosAnuncios(contaId, (n, t) => {
      mainWindow?.webContents.send('mkt:anuncios:progresso', { n, t });
    });
    return { ok: true, ...resultado };
  } catch(e) { return { ok: false, erro: e.message }; }
});
ipcMain.handle('mkt:anuncios:sincronizarUm', async (_, contaId, itemId) => {
  try {
    const item = await shopee.getItemDetalhe(contaId, itemId);
    if (item) db.mktAnuncios.salvarUm(contaId, 'shopee', item);
    return { ok: true, item };
  } catch(e) { return { ok: false, erro: e.message }; }
});
ipcMain.handle('mkt:anuncios:verificarNovos', async (_, contaId) => {
  try { return { ok: true, ...(await shopee.verificarNovosAnuncios(contaId)) }; }
  catch(e) { return { ok: false, erro: e.message }; }
});

ipcMain.handle('mkt:anuncios:mapear', async (_, contaId, itemId, produto) => {
  try {
    // Salva mapeamento local
    db.mktAnuncios.mapear(contaId, itemId, produto.id, produto.nome, produto.sku);

    // Busca base44_id do anúncio e atualiza no Base44
    const anuncio = db.mktAnuncios.getByItemId(contaId, itemId);
    const store = require('electron-store');
    const s = new store();
    const usuario = s.get('auth.usuario') || {};
    if (anuncio?.base44_id) {
      await api.mapearAnuncioBase44(anuncio.base44_id, produto.id, produto.nome, produto.sku, usuario.nome || 'PDV');
    } else {
      // Tenta buscar o Anuncio no Base44 pelo item_id e atualiza
      try {
        const remotos = await api.listarAnunciosRemoto(contaId);
        const remoto = remotos.find(r => r.marketplace_anuncio_id === String(itemId));
        if (remoto?._id) {
          db.mktAnuncios.salvarBase44Id(contaId, itemId, remoto._id);
          await api.mapearAnuncioBase44(remoto._id, produto.id, produto.nome, produto.sku, usuario.nome || 'PDV');
        }
      } catch {}
    }
    return { ok: true };
  } catch(e) { return { ok: false, erro: e.message }; }
});

ipcMain.handle('mkt:anuncios:enviarBase44', async (_, contaId) => {
  try {
    const conta = shopee.getConta(contaId);
    if (!conta) return { ok: false, erro: 'Conta não encontrada' };

    // listar sem filtro retorna todos (sem paginação quando não tem status/busca)
    const { rows: anuncios } = db.mktAnuncios.listar(contaId, '', '', 0, 99999);
    if (!anuncios.length) return { ok: false, erro: 'Nenhum anúncio no banco. Importe primeiro.' };

    // Usa empresa_id e marketplace_config_id da conta ou do usuário logado
    const store = require('electron-store');
    const s = new store();
    const usuario = s.get('auth.usuario') || {};
    const contaInfo = {
      ...conta,
      empresa_id: conta.empresa_id || usuario.empresa_id || null,
      empresa_nome: conta.empresa_nome || usuario.empresa_nome || null,
      marketplace_config_id: conta.marketplace_config_id || contaId,
    };

    const res = await api.sincronizarAnunciosBase44(contaInfo, anuncios, (n, t) => {
      if (mainWindow) mainWindow.webContents.send('mkt:anuncios:base44progresso', { n, t });
    });
    return { ok: true, ...res };
  } catch(e) { return { ok: false, erro: e.message }; }
});

// ─── Pedidos Marketplace ──────────────────────────────────────────────
ipcMain.handle('mkt:pedidos:listar', (_, contaId, filtros, pagina) =>
  db.mktPedidos.listar(contaId, filtros || {}, pagina || 0));

ipcMain.handle('mkt:pedidos:importar', async (_, contaId, diasAtras) => {
  try {
    const res = await _mkt(contaId).importarPedidos(contaId, diasAtras || 30);
    await _enviarPedidosPendentesBase44(contaId);
    return { ok: true, ...res };
  } catch(e) { return { ok: false, erro: e.message }; }
});

ipcMain.handle('mkt:pedidos:buscarNovos', async (_, contaId) => {
  try {
    const res = await _mkt(contaId).buscarPedidosNovos(contaId);
    if (res.novos > 0) await _enviarPedidosPendentesBase44(contaId);
    return { ok: true, ...res };
  } catch(e) { return { ok: false, erro: e.message }; }
});

ipcMain.handle('mkt:pedidos:enviarBase44', async (_, contaId) => {
  try {
    const n = await _enviarPedidosPendentesBase44(contaId);
    return { ok: true, enviados: n };
  } catch(e) { return { ok: false, erro: e.message }; }
});

// Atualiza um item do pedido (mapeamento manual no modal) e re-envia ao Base44
ipcMain.handle('mkt:pedidos:atualizarItem', async (_, contaId, pedidoId, itemIdx, produto) => {
  try {
    const pedido = db.mktPedidos.getById(contaId, pedidoId);
    if (!pedido) return { ok: false, erro: 'Pedido não encontrado' };

    const itens = JSON.parse(pedido.itens_json || '[]');
    if (itemIdx < 0 || itemIdx >= itens.length) return { ok: false, erro: 'Item inválido' };

    itens[itemIdx] = {
      ...itens[itemIdx],
      produto_id:    produto.id,
      produto_nome:  produto.nome,
      produto_sku:   produto.sku || '',
      nao_mapeado:   false,
    };

    // Se o anúncio tem item_id, salva mapeamento permanente no cadastro de anúncios
    const itemId = itens[itemIdx].marketplace_anuncio_id;
    if (itemId) {
      db.mktAnuncios.mapear(contaId, itemId, produto.id, produto.nome, produto.sku || '');
    }

    // Verifica se ainda tem itens não mapeados
    const aindaTemBloqueio = itens.some(i => i.nao_mapeado);
    const novoStatus = aindaTemBloqueio ? pedido.status_shopee : pedido.status_shopee;

    // Atualiza itens_json no banco
    db.mktPedidos.atualizarItens(contaId, pedidoId, JSON.stringify(itens), aindaTemBloqueio ? 'pendente' : 'pendente');

    // Re-envia ao Base44
    const Store = require('electron-store');
    const s = new Store();
    const usuario = s.get('auth.usuario') || {};
    const conta = shopee.getConta(contaId);
    const contaInfo = { ...conta, empresa_id: conta?.empresa_id || usuario.empresa_id, empresa_nome: conta?.empresa_nome || usuario.empresa_nome };
    const pedidoAtual = db.mktPedidos.getById(contaId, pedidoId);
    const res = await api.enviarPedidoBase44(pedidoAtual, contaInfo);
    db.mktPedidos.marcarEnviadoBase44(pedidoAtual.id, res._id || res.id || '');

    return { ok: true, aindaTemBloqueio };
  } catch(e) { return { ok: false, erro: e.message }; }
});

async function _enviarPedidosPendentesBase44(contaId) {
  const conta = shopee.getConta(contaId);
  if (!conta) return 0;
  const Store = require('electron-store');
  const s = new Store();
  const usuario = s.get('auth.usuario') || {};
  const contaInfo = {
    ...conta,
    empresa_id: conta.empresa_id || usuario.empresa_id || null,
    empresa_nome: conta.empresa_nome || usuario.empresa_nome || null,
    marketplace_config_id: conta.marketplace_config_id || contaId,
  };
  const pendentes = db.mktPedidos.getPendentesBase44(contaId);
  let enviados = 0;
  for (const p of pendentes) {
    try {
      const res = await api.enviarPedidoBase44(p, contaInfo);
      db.mktPedidos.marcarEnviadoBase44(p.id, res._id || res.id || '');
      enviados++;
    } catch(e) {
      db.mktPedidos.marcarErroBase44(p.id, e.message);
      console.warn('[Pedidos] Erro ao enviar para Base44:', p.pedido_id, e.message);
    }
  }
  if (enviados > 0 && mainWindow) {
    mainWindow.webContents.send('mkt:pedidos:novos', { contaId, enviados });
  }
  return enviados;
}

// Polling automático a cada 5 minutos para todas as contas conectadas
function _iniciarPollingPedidos() {
  const INTERVALO = 5 * 60 * 1000;
  const _poll = async () => {
    const contas = [
      ...shopee.listarContas().filter(c => c.conectado && c.access_token),
      ...tiktok.listarContas().filter(c => c.conectado && c.access_token),
    ];
    for (const c of contas) {
      try {
        const res = await _mkt(c.id).buscarPedidosNovos(c.id);
        if (res.novos > 0) {
          console.log(`[Pedidos] ${res.novos} novo(s) pedido(s) para conta ${c.nome}`);
          await _enviarPedidosPendentesBase44(c.id);
        }
      } catch(e) { console.warn('[Pedidos] Polling erro:', c.nome, e.message); }
    }
  };
  setTimeout(() => { _poll(); setInterval(_poll, INTERVALO); }, 10000); // começa 10s após o app abrir
}

// Sync
ipcMain.handle('sync:status', () => sync.getStatus());
ipcMain.handle('sync:now', async () => {
  const result = await sync.syncNow(mainWindow);
  return result;
});
ipcMain.handle('sync:fullProdutos', async () => {
  await sync.syncUpProdutos();
  return await sync.syncForcarProdutos();
});
ipcMain.handle('sync:pendentes', () => db.sync.getPendentes());

// Auth
ipcMain.handle('auth:login', async (_, login, senha) => {
  return await api.autenticarPDV(login, senha);
});
ipcMain.handle('auth:logout', () => {
  store.delete('auth.token');
  store.delete('auth.usuario');
});

// Impressão
ipcMain.handle('print:local', async (_, dados) => {
  return printServer.adicionarNaFila(dados);
});
ipcMain.handle('print:orcamento', async (_, orc) => {
  const html = printServer.gerarHtmlOrcamento({
    ...orc,
    empresa_nome: store.get('auth.usuario.empresa_nome') || '',
    vendedor_nome: orc.vendedor_nome || store.get('auth.usuario.nome') || '',
  });
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false } });
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.webContents.once('did-finish-load', () => {
      win.webContents.print({ silent: false, printBackground: true }, (success, reason) => {
        win.destroy();
        if (success) resolve({ ok: true });
        else resolve({ ok: false, reason });
      });
    });
    win.webContents.once('did-fail-load', (_, code, desc) => {
      win.destroy();
      reject(new Error(desc));
    });
  });
});
ipcMain.handle('print:entrega', async (_, dados) => {
  const html = printServer.gerarHtmlCupomEntrega(dados);
  const ip   = store.get('config.print_server_ip');
  if (ip) {
    try { return await printServer.enviarParaServidor({ ...dados, _html: html }); }
    catch { /* cai no local */ }
  }
  return printServer.imprimirLocal({ ...dados, _html: html });
});
ipcMain.handle('print:servidor', async (_, dados) => {
  try {
    return await printServer.enviarParaServidor(dados);
  } catch (err) {
    return { erro: err.message };
  }
});
ipcMain.handle('print:server:start', (_, porta) => {
  const p = porta || store.get('config.print_server_porta') || 3001;
  return printServer.start(p);
});
ipcMain.handle('print:server:stop', () => {
  printServer.stop();
  return { ok: true };
});
ipcMain.handle('print:server:status', () => ({
  rodando: printServer.isRunning(),
  porta: store.get('config.print_server_porta') || 3001,
}));
ipcMain.handle('print:listar', async () => {
  return printServer.listarImpressoras(mainWindow);
});
ipcMain.handle('print:ping', async (_, url) => {
  try {
    const pingUrl = url.startsWith('http://') || url.startsWith('https://')
      ? url.replace(/\/$/, '') + '/ping'
      : `http://${url}/ping`;
    const res = await require('node-fetch')(pingUrl, { timeout: 5000 });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
});

// Carteira de Clientes
ipcMain.handle('carteira:sincronizar', async () => sync.syncForcarCarteira());
ipcMain.handle('carteira:diagnostico', () => {
  const total = db.db().prepare("SELECT COUNT(*) as n, SUM(valor) as s FROM contas_receber WHERE status='pendente'").get();
  const porCliente = db.db().prepare("SELECT cliente_id, cliente_nome, COUNT(*) as n, SUM(valor) as s FROM contas_receber WHERE status='pendente' GROUP BY cliente_id ORDER BY s DESC LIMIT 20").all();
  const clientes = db.db().prepare('SELECT remote_id, nome FROM clientes WHERE remote_id IS NOT NULL').all();
  return { total, porCliente, clientes };
});
ipcMain.handle('carteira:resumo', () => db.creditosCliente.resumoGeral());
ipcMain.handle('carteira:listar', (_, query) => db.creditosCliente.listarCarteira(query || ''));
ipcMain.handle('carteira:ultimoPgto', (_, remoteId) => db.creditosCliente.ultimoPagamento(remoteId));
ipcMain.handle('carteira:contasAbertas', (_, clienteRemoteId) => db.contasReceber.getContasAbertas(clienteRemoteId));
ipcMain.handle('carteira:pagar', async (_, contaId, forma, obs) => {
  db.contasReceber.marcarPago(contaId, forma, obs);
  try {
    await api.pagarContaReceber(contaId, forma, obs);
    return { ok: true };
  } catch (err) {
    return { ok: true, offline: true };
  }
});

ipcMain.handle('carteira:pagarParcial', async (_, contaId, valorPago, valorOriginal, forma, obs) => {
  const valorRestante = Math.round((valorOriginal - valorPago) * 100) / 100;
  const obsCompleta = `Pgto parcial R$ ${valorPago.toFixed(2)} (${forma})${obs ? ' — ' + obs : ''}`;
  db.contasReceber.atualizarValor(contaId, valorRestante, obsCompleta);
  try {
    await api.pagarContaReceberParcial(contaId, valorPago, valorOriginal, forma, obs);
    return { ok: true, valorRestante };
  } catch (err) {
    return { ok: true, offline: true, valorRestante };
  }
});

ipcMain.handle('carteira:usarCredito', async (_, contaId, contaValor, creditoId, creditoSaldo, obs) => {
  try {
    const resultado = await api.usarCreditoEmConta(contaId, contaValor, creditoId, creditoSaldo, 'credito_loja', obs);
    if (resultado.quitou) {
      db.contasReceber.marcarPago(contaId, 'credito_loja', obs || 'Pago com crédito loja');
    } else {
      db.contasReceber.atualizarValor(contaId, resultado.valorRestante, `Crédito loja aplicado`);
    }
    // Atualizar saldo do crédito localmente
    if (resultado.saldoCreditoRestante <= 0) {
      db.creditosCliente.marcarUsado(creditoId);
    }
    return { ok: true, ...resultado };
  } catch (err) {
    return { ok: false, erro: err.message };
  }
});

// Entregas
ipcMain.handle('entregas:salvar', async (_, entrega) => {
  const cfgAll = store.store;
  const usuario = cfgAll?.auth?.usuario;
  entrega.empresa_id = entrega.empresa_id || cfgAll?.auth?.empresa_id || '';
  entrega.terminal_id = entrega.terminal_id || store.get('config.terminal_id') || 'PDV-001';
  entrega.criado_por = entrega.criado_por || usuario?.nome || 'operador';
  const local = db.entregas.salvar(entrega);
  try {
    const remote = await api.registrarEntrega(local);
    if (remote?.id) db.entregas.atualizar(local.id, { remote_id: remote.id, sync_status: 'synced', synced_at: new Date().toISOString() });
    return { ok: true, id: local.id, remote_id: remote?.id };
  } catch (err) {
    console.warn('[ENTREGA] Offline — salvo local:', err.message);
    return { ok: true, id: local.id, offline: true };
  }
});

ipcMain.handle('entregas:listar', async (_, filtros) => {
  const empresa_id = store.get('auth.empresa_id') || '';
  try {
    const remotas = await api.listarEntregasRemoto(empresa_id, filtros?.status || null);
    for (const r of remotas) db.entregas.upsertRemote(r);
  } catch {}
  return db.entregas.listar({ empresa_id, ...(filtros || {}) });
});

ipcMain.handle('entregas:atualizar', async (_, id, dados) => {
  db.entregas.atualizar(id, dados);
  const entrega = db.entregas.getById(id);
  if (entrega?.remote_id) {
    try { await api.atualizarEntrega(entrega.remote_id, dados); } catch {}
  }
  return { ok: true };
});

ipcMain.handle('entregas:getById', (_, id) => db.entregas.getById(id));

// Cloudflare Tunnel
ipcMain.handle('tunnel:start', async (_, porta) => {
  return tunnel.start(porta || store.get('config.print_server_porta') || 3001, (status) => {
    mainWindow?.webContents.send('tunnel:status', status);
    // Publica a URL nova pro Supabase — os terminais de venda consultam
    // isso a cada sincronização e se auto-configuram, sem digitar nada.
    if (status.estado === 'ativo' && status.url) {
      api.atualizarUrlImpressao(status.url).catch(() => {});
    }
  });
});
ipcMain.handle('tunnel:stop', () => { tunnel.stop(); return { ok: true }; });
ipcMain.handle('tunnel:status', () => tunnel.getStatus());

// NFC-e / FocusNFe
ipcMain.handle('nfce:emitir', async (_, venda) => {
  try {
    // Enriquecer itens com dados fiscais do produto local (NCM, CFOP, CSTs)
    if (venda.itens && venda.itens.length) {
      venda.itens = venda.itens.map(item => {
        const prod = item.produto_id
          ? db.db().prepare('SELECT ncm, cfop, icms_cst, icms_origem, pis_cst, cofins_cst, unidade FROM produtos WHERE id = ? OR remote_id = ?').get(item.produto_id, item.produto_id)
          : null;
        return {
          ...item,
          ncm:        (prod?.ncm        || item.ncm        || '').replace(/\D/g, ''),
          cfop:       prod?.cfop        || item.cfop        || '5102',
          icms_cst:   prod?.icms_cst    || item.icms_cst    || '400',
          icms_origem:prod?.icms_origem ?? item.icms_origem ?? 0,
          pis_cst:    prod?.pis_cst     || item.pis_cst     || '07',
          cofins_cst: prod?.cofins_cst  || item.cofins_cst  || '07',
          unidade:    prod?.unidade     || item.unidade      || 'UN',
        };
      });
    }
    return await focusnfe.emitirNFCe(venda);
  } catch (err) {
    return { ok: false, erro: err.message };
  }
});
ipcMain.handle('nfce:consultar', async (_, reference) => {
  try {
    return await focusnfe.consultarNFCe(reference);
  } catch (err) {
    return { ok: false, erro: err.message };
  }
});
ipcMain.handle('nfce:cancelar', async (_, reference, justificativa) => {
  try {
    return await focusnfe.cancelarNFCe(reference, justificativa);
  } catch (err) {
    return { ok: false, erro: err.message };
  }
});
ipcMain.handle('nfce:danfe', async (_, reference) => {
  try {
    return await focusnfe.obterDanfe(reference);
  } catch (err) {
    return { ok: false, erro: err.message };
  }
});

ipcMain.handle('nfce:registrarBase44', async (_, remoteId, dados) => {
  try {
    return await api.registrarNfceVenda(remoteId, dados);
  } catch (err) {
    console.warn('[nfce:registrarBase44]', err.message);
    return { ok: false, erro: err.message };
  }
});

ipcMain.handle('vendas:atualizarNfce', (_, id, dados) => {
  try { db.vendas.atualizarNfce(id, dados); return { ok: true }; }
  catch (err) { console.warn('[vendas:atualizarNfce]', err.message); return { ok: false }; }
});

// Atualização
ipcMain.handle('update:check', () => updater.checarAgora());
ipcMain.handle('update:install', () => updater.instalarAgora());

// Sistema
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:openExternal', (_, url) => { shell.openExternal(url); return true; });
ipcMain.handle('app:reload', () => mainWindow?.reload());
ipcMain.handle('app:minimize', () => mainWindow?.minimize());
ipcMain.handle('app:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle('app:close', () => mainWindow?.close());

ipcMain.handle('dialog:confirm', async (_, msg) => {
  const res = await dialog.showMessageBox(mainWindow, {
    type: 'question', buttons: ['Cancelar', 'Confirmar'],
    title: 'Confirmação', message: msg
  });
  return res.response === 1;
});

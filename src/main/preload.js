const { contextBridge, ipcRenderer } = require('electron');

// Expõe API segura para o renderer (sem acesso direto ao Node)
contextBridge.exposeInMainWorld('pdv', {

  // Config
  config: {
    get: (key) => ipcRenderer.invoke('config:get', key),
    set: (key, val) => ipcRenderer.invoke('config:set', key, val),
    getAll: () => ipcRenderer.invoke('config:getAll'),
  },

  // Produtos
  produtos: {
    buscar: (query) => ipcRenderer.invoke('produtos:buscar', query),
    buscarGestao: (query) => ipcRenderer.invoke('produtos:buscarGestao', query),
    getById: (id) => ipcRenderer.invoke('produtos:getById', id),
    getByEan: (ean) => ipcRenderer.invoke('produtos:getByEan', ean),
    total: () => ipcRenderer.invoke('produtos:total'),
    salvar: (p) => ipcRenderer.invoke('produtos:salvar', p),
    atualizar: (id, dados) => ipcRenderer.invoke('produtos:atualizar', id, dados),
  },

  // Clientes
  clientes: {
    buscar: (query) => ipcRenderer.invoke('clientes:buscar', query),
    getById: (id) => ipcRenderer.invoke('clientes:getById', id),
    salvar: (c) => ipcRenderer.invoke('clientes:salvar', c),
    credito: (id) => ipcRenderer.invoke('clientes:credito', id),
    syncForcar: () => ipcRenderer.invoke('clientes:syncForcar'),
    atualizarEndereco: (remoteId, dados) => ipcRenderer.invoke('clientes:atualizarEndereco', remoteId, dados),
  },

  // Vendedores
  vendedores: {
    getByCodigo: (codigo) => ipcRenderer.invoke('vendedores:getByCodigo', codigo),
    listar: () => ipcRenderer.invoke('vendedores:listar'),
  },

  // Créditos Cliente (Contas a Receber)
  creditos: {
    getAbertos: (clienteRemoteId) => ipcRenderer.invoke('creditos:getAbertos', clienteRemoteId),
    resumo: (clienteRemoteId) => ipcRenderer.invoke('creditos:resumo', clienteRemoteId),
    receber: (remoteId, valorPago, saldoAtual, obs) =>
      ipcRenderer.invoke('creditos:receber', remoteId, valorPago, saldoAtual, obs),
    criarCredito: (clienteRemoteId, nome, tel, valor, obs) =>
      ipcRenderer.invoke('creditos:criar', clienteRemoteId, nome, tel, valor, obs),
  },

  // Vendas
  vendas: {
    registrar: (v) => ipcRenderer.invoke('vendas:registrar', v),
    listar: (f) => ipcRenderer.invoke('vendas:listar', f),
    getById: (id) => ipcRenderer.invoke('vendas:getById', id),
    cancelar: (id, motivo) => ipcRenderer.invoke('vendas:cancelar', id, motivo),
    editar:   (id, itens, dados) => ipcRenderer.invoke('vendas:editar', id, itens, dados),
    atualizarNfce: (id, dados) => ipcRenderer.invoke('vendas:atualizarNfce', id, dados),
    totaisHoje: () => ipcRenderer.invoke('vendas:totaisHoje'),
    listarCloud: (data) => ipcRenderer.invoke('vendas:listarCloud', data),
    atualizarCliente: (id, clienteId, nome, tel) => ipcRenderer.invoke('vendas:atualizarCliente', id, clienteId, nome, tel),
    repararClientes: (cb) => { ipcRenderer.on('vendas:reparo-progresso', (_, d) => cb && cb(d)); return ipcRenderer.invoke('vendas:repararClientes'); },
  },

  // Orçamentos
  orcamentos: {
    registrar:       (orc)        => ipcRenderer.invoke('orcamentos:registrar', orc),
    listar:          (filtros)    => ipcRenderer.invoke('orcamentos:listar', filtros),
    getById:         (id)         => ipcRenderer.invoke('orcamentos:getById', id),
    cancelar:        (id)         => ipcRenderer.invoke('orcamentos:cancelar', id),
    marcarConvertido:(id)         => ipcRenderer.invoke('orcamentos:marcarConvertido', id),
    atualizarCliente:(id, clienteId, nome, tel) => ipcRenderer.invoke('orcamentos:atualizarCliente', id, clienteId, nome, tel),
    listarCloud:     (filtros)    => ipcRenderer.invoke('orcamentos:listarCloud', filtros),
    getByIdCloud:    (remoteId)   => ipcRenderer.invoke('orcamentos:getByIdCloud', remoteId),
  },

  // Estoque
  estoque: {
    get: (id) => ipcRenderer.invoke('estoque:get', id),
    movimentar: (m) => ipcRenderer.invoke('estoque:movimentar', m),
    alertas: () => ipcRenderer.invoke('estoque:alertas'),
  },

  // Faltas
  faltas: {
    registrar: (f) => ipcRenderer.invoke('faltas:registrar', f),
    listar: (filtros) => ipcRenderer.invoke('faltas:listar', filtros),
    atualizarStatus: (id, status) => ipcRenderer.invoke('faltas:atualizarStatus', id, status),
    contarPendentes: () => ipcRenderer.invoke('faltas:contarPendentes'),
  },

  // Sync
  sync: {
    status: () => ipcRenderer.invoke('sync:status'),
    now: () => ipcRenderer.invoke('sync:now'),
    fullProdutos: () => ipcRenderer.invoke('sync:fullProdutos'),
    pendentes: () => ipcRenderer.invoke('sync:pendentes'),
    onUpdate: (cb) => ipcRenderer.on('sync:update', (_, data) => cb(data)),
  },

  // Auth
  auth: {
    login: (u, s) => ipcRenderer.invoke('auth:login', u, s),
    logout: () => ipcRenderer.invoke('auth:logout'),
  },

  // Carteira de Clientes
  carteira: {
    sincronizar:   ()                                    => ipcRenderer.invoke('carteira:sincronizar'),
    resumo:        ()                                    => ipcRenderer.invoke('carteira:resumo'),
    listar:        (query)                               => ipcRenderer.invoke('carteira:listar', query),
    ultimoPgto:    (id)                                  => ipcRenderer.invoke('carteira:ultimoPgto', id),
    contasAbertas: (clienteId)                           => ipcRenderer.invoke('carteira:contasAbertas', clienteId),
    pagar:         (id, forma, obs)                      => ipcRenderer.invoke('carteira:pagar', id, forma, obs),
    pagarParcial:  (id, valorPago, valorOrig, forma, obs) => ipcRenderer.invoke('carteira:pagarParcial', id, valorPago, valorOrig, forma, obs),
    usarCredito:   (contaId, contaValor, creditoId, creditoSaldo, obs) => ipcRenderer.invoke('carteira:usarCredito', contaId, contaValor, creditoId, creditoSaldo, obs),
  },

  // Entregas
  entregas: {
    salvar:   (e)         => ipcRenderer.invoke('entregas:salvar', e),
    listar:   (filtros)   => ipcRenderer.invoke('entregas:listar', filtros),
    atualizar:(id, dados) => ipcRenderer.invoke('entregas:atualizar', id, dados),
    getById:  (id)        => ipcRenderer.invoke('entregas:getById', id),
  },

  // Impressão
  print: {
    local:         (dados)  => ipcRenderer.invoke('print:local', dados),
    servidor:      (dados)  => ipcRenderer.invoke('print:servidor', dados),
    entrega:       (dados)  => ipcRenderer.invoke('print:entrega', dados),
    serverStart:   (porta)  => ipcRenderer.invoke('print:server:start', porta),
    serverStop:    ()       => ipcRenderer.invoke('print:server:stop'),
    serverStatus:  ()       => ipcRenderer.invoke('print:server:status'),
    listar:        ()       => ipcRenderer.invoke('print:listar'),
    ping:          (url)   => ipcRenderer.invoke('print:ping', url),
  },

  // Cloudflare Tunnel
  tunnel: {
    start:    (porta) => ipcRenderer.invoke('tunnel:start', porta),
    stop:     ()      => ipcRenderer.invoke('tunnel:stop'),
    status:   ()      => ipcRenderer.invoke('tunnel:status'),
    onStatus: (cb)    => ipcRenderer.on('tunnel:status', (_, data) => cb(data)),
  },

  // Atualização
  update: {
    check:   () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (cb) => ipcRenderer.on('update:status', (_, data) => cb(data)),
  },

  // NFC-e
  nfce: {
    emitir:          (venda)           => ipcRenderer.invoke('nfce:emitir', venda),
    consultar:       (reference)       => ipcRenderer.invoke('nfce:consultar', reference),
    cancelar:        (reference, just) => ipcRenderer.invoke('nfce:cancelar', reference, just),
    danfe:           (reference)       => ipcRenderer.invoke('nfce:danfe', reference),
    registrarBase44: (remoteId, dados) => ipcRenderer.invoke('nfce:registrarBase44', remoteId, dados),
  },

  // IA
  ia: {
    fiscal:        (nome, cat, un) => ipcRenderer.invoke('ia:fiscal', nome, cat, un),
    descricao:     (nome, cat, marca, un) => ipcRenderer.invoke('ia:descricao', nome, cat, marca, un),
    lote:          (produtos) => ipcRenderer.invoke('ia:lote', produtos),
    status:        () => ipcRenderer.invoke('ia:status'),
    buscarImagem:  (nome, ean) => ipcRenderer.invoke('ia:buscarImagem', nome, ean),
  },

  // Marketplace multi-conta
  mkt: {
    listarContas:  (canal)        => ipcRenderer.invoke('mkt:listarContas', canal),
    getConta:      (id)           => ipcRenderer.invoke('mkt:getConta', id),
    salvarConta:   (dados)        => ipcRenderer.invoke('mkt:salvarConta', dados),
    removerConta:  (id)           => ipcRenderer.invoke('mkt:removerConta', id),
    conectar:      (id)           => ipcRenderer.invoke('mkt:conectar', id),
    desconectar:   (id)           => ipcRenderer.invoke('mkt:desconectar', id),
    shopInfo:      (id)           => ipcRenderer.invoke('mkt:shopInfo', id),
    anuncios:      (id, page)     => ipcRenderer.invoke('mkt:anuncios', id, page),
    pedidos:       (id, status)   => ipcRenderer.invoke('mkt:pedidos', id, status),
    trocarCodigo:  (id, code, shopId) => ipcRenderer.invoke('mkt:trocarCodigo', id, code, shopId),
    anunciosLocal: {
      listar:          (contaId, busca, status, pagina) => ipcRenderer.invoke('mkt:anuncios:listar', contaId, busca, status, pagina),
      total:           (contaId)             => ipcRenderer.invoke('mkt:anuncios:total', contaId),
      importar:        (contaId)             => ipcRenderer.invoke('mkt:anuncios:importar', contaId),
      sincronizarUm:   (contaId, itemId)     => ipcRenderer.invoke('mkt:anuncios:sincronizarUm', contaId, itemId),
      verificarNovos:  (contaId)             => ipcRenderer.invoke('mkt:anuncios:verificarNovos', contaId),
      onProgresso:     (cb)                  => ipcRenderer.on('mkt:anuncios:progresso', (_, d) => cb(d)),
      enviarBase44:    (contaId)             => ipcRenderer.invoke('mkt:anuncios:enviarBase44', contaId),
      mapear:          (contaId, itemId, produto) => ipcRenderer.invoke('mkt:anuncios:mapear', contaId, itemId, produto),
      onBase44Progresso: (cb)               => ipcRenderer.on('mkt:anuncios:base44progresso', (_, d) => cb(d)),
    },
    pedidosLocal: {
      listar:       (contaId, filtros, pagina) => ipcRenderer.invoke('mkt:pedidos:listar', contaId, filtros, pagina),
      importar:     (contaId, dias)            => ipcRenderer.invoke('mkt:pedidos:importar', contaId, dias),
      buscarNovos:  (contaId)                  => ipcRenderer.invoke('mkt:pedidos:buscarNovos', contaId),
      enviarBase44: (contaId)                  => ipcRenderer.invoke('mkt:pedidos:enviarBase44', contaId),
      onNovos:      (cb)                       => ipcRenderer.on('mkt:pedidos:novos', (_, d) => cb(d)),
      atualizarItem:(contaId, pedidoId, itemIdx, produto) => ipcRenderer.invoke('mkt:pedidos:atualizarItem', contaId, pedidoId, itemIdx, produto),
    },
  },

  // WhatsApp
  whatsapp: {
    enviar: (tipo, id, telefone, dadosExtras) => ipcRenderer.invoke('whatsapp:enviar', tipo, id, telefone, dadosExtras),
  },

  // App
  app: {
    version: () => ipcRenderer.invoke('app:version'),
    reload: () => ipcRenderer.invoke('app:reload'),
    minimize: () => ipcRenderer.invoke('app:minimize'),
    maximize: () => ipcRenderer.invoke('app:maximize'),
    close: () => ipcRenderer.invoke('app:close'),
    confirm: (msg) => ipcRenderer.invoke('dialog:confirm', msg),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  }
});

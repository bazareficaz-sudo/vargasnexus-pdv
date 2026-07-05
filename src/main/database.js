/**
 * database.js — Camada SQLite local (offline-first)
 * Otimizado para grandes volumes: índices em nome, ean, sku
 * WAL mode para escritas concorrentes rápidas
 */

const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(app.getPath('userData'), 'pdv-vargas.db');
let db;

// ─── Inicializar banco ────────────────────────────────────────────
function initialize() {
  db = new Database(DB_PATH);

  // Performance: WAL mode + cache generoso para 14k produtos
  db.pragma('journal_mode = WAL');
  db.pragma('cache_size = -32000'); // 32MB cache
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');

  createTables();
  runMigrations();
  createIndexes();
  console.log(`[DB] SQLite inicializado em: ${DB_PATH}`);
}

function createTables() {
  db.exec(`
    -- Produtos (14k+)
    CREATE TABLE IF NOT EXISTS produtos (
      id TEXT PRIMARY KEY,
      remote_id TEXT UNIQUE,
      nome TEXT NOT NULL,
      nome_lower TEXT, -- coluna pré-processada para busca rápida
      sku TEXT,
      ean TEXT,
      preco_venda REAL NOT NULL DEFAULT 0,
      preco_custo REAL DEFAULT 0,
      unidade TEXT DEFAULT 'UN',
      categoria TEXT,
      marca TEXT,
      foto_url TEXT,
      ativo INTEGER DEFAULT 1,
      disponivel_pdv INTEGER DEFAULT 1,
      permite_fracao INTEGER DEFAULT 0,
      updated_at TEXT,
      synced_at TEXT,
      sync_status TEXT DEFAULT 'synced' -- 'synced' | 'pending' | 'conflict'
    );

    -- Estoque por depósito
    CREATE TABLE IF NOT EXISTS estoque (
      id TEXT PRIMARY KEY,
      produto_id TEXT NOT NULL,
      deposito_id TEXT,
      empresa_id TEXT,
      quantidade REAL DEFAULT 0,
      quantidade_minima REAL DEFAULT 0,
      updated_at TEXT,
      FOREIGN KEY (produto_id) REFERENCES produtos(id)
    );

    -- Clientes
    CREATE TABLE IF NOT EXISTS clientes (
      id TEXT PRIMARY KEY,
      remote_id TEXT UNIQUE,
      nome TEXT NOT NULL,
      nome_lower TEXT,
      cpf_cnpj TEXT,
      telefone TEXT,
      email TEXT,
      limite_credito REAL DEFAULT 0,
      saldo_credito REAL DEFAULT 0,   -- crédito loja (devoluções) — legado
      saldo_devedor REAL DEFAULT 0,   -- fiado/carteira: o que o cliente deve à loja
      status_credito TEXT DEFAULT 'liberado',
      permite_carteira INTEGER DEFAULT 0,
      updated_at TEXT,
      synced_at TEXT,
      sync_status TEXT DEFAULT 'synced'
    );

    -- Vendas
    CREATE TABLE IF NOT EXISTS vendas (
      id TEXT PRIMARY KEY,
      remote_id TEXT UNIQUE,
      numero INTEGER,
      cliente_id TEXT,
      empresa_id TEXT,
      deposito_id TEXT,
      operador_id TEXT,
      operador_nome TEXT,
      vendedor_id TEXT,
      vendedor_nome TEXT,
      vendedor_codigo TEXT,
      status TEXT DEFAULT 'concluida', -- concluida | cancelada | pendente
      subtotal REAL NOT NULL,
      desconto REAL DEFAULT 0,
      total REAL NOT NULL,
      forma_pagamento TEXT, -- dinheiro | pix | credito | debito | credito_cliente | misto
      valor_pago REAL,
      troco REAL DEFAULT 0,
      observacao TEXT,
      created_at TEXT NOT NULL,
      synced_at TEXT,
      sync_status TEXT DEFAULT 'pending' -- sempre pending até confirmar com servidor
    );

    -- Itens de venda
    CREATE TABLE IF NOT EXISTS venda_itens (
      id TEXT PRIMARY KEY,
      venda_id TEXT NOT NULL,
      produto_id TEXT NOT NULL,
      produto_nome TEXT,
      produto_sku TEXT,
      quantidade REAL NOT NULL,
      preco_unitario REAL NOT NULL,
      desconto REAL DEFAULT 0,
      total REAL NOT NULL,
      FOREIGN KEY (venda_id) REFERENCES vendas(id),
      FOREIGN KEY (produto_id) REFERENCES produtos(id)
    );

    -- Movimentações de estoque
    CREATE TABLE IF NOT EXISTS movimentacoes_estoque (
      id TEXT PRIMARY KEY,
      remote_id TEXT UNIQUE,
      produto_id TEXT NOT NULL,
      deposito_id TEXT,
      tipo TEXT NOT NULL, -- entrada | saida | ajuste | venda | cancelamento
      quantidade REAL NOT NULL,
      quantidade_anterior REAL,
      quantidade_posterior REAL,
      referencia_id TEXT, -- venda_id ou outro
      referencia_tipo TEXT,
      operador_id TEXT,
      observacao TEXT,
      created_at TEXT NOT NULL,
      sync_status TEXT DEFAULT 'pending'
    );

    -- Pagamentos de crédito cliente
    CREATE TABLE IF NOT EXISTS credito_movimentacoes (
      id TEXT PRIMARY KEY,
      remote_id TEXT UNIQUE,
      cliente_id TEXT NOT NULL,
      venda_id TEXT,
      tipo TEXT NOT NULL, -- credito | debito
      valor REAL NOT NULL,
      saldo_anterior REAL,
      saldo_posterior REAL,
      observacao TEXT,
      created_at TEXT NOT NULL,
      sync_status TEXT DEFAULT 'pending'
    );

    -- Contas a receber do cliente (CreditoCliente do Base44)
    CREATE TABLE IF NOT EXISTS creditos_cliente (
      id TEXT PRIMARY KEY,          -- remote_id do Base44
      empresa_id TEXT,
      cliente_id TEXT,              -- remote_id do cliente
      cliente_nome TEXT,
      cliente_telefone TEXT,
      venda_origem_id TEXT,
      venda_origem_numero INTEGER,
      valor_original REAL NOT NULL DEFAULT 0,
      saldo_atual REAL DEFAULT 0,
      status TEXT DEFAULT 'aberto', -- aberto | usado_parcialmente | usado_totalmente | estornado | cancelado
      origem TEXT,                  -- troca | devolucao | ajuste_manual
      observacao TEXT,
      created_date TEXT,
      updated_date TEXT
    );

    -- Contas a Receber (fiado / carteira) — sincronizado de ContaReceber no Base44
    CREATE TABLE IF NOT EXISTS contas_receber (
      id TEXT PRIMARY KEY,        -- remote_id do Base44
      empresa_id TEXT,
      cliente_id TEXT,            -- remote_id do cliente
      cliente_nome TEXT,
      valor REAL NOT NULL DEFAULT 0,
      descricao TEXT,
      origem TEXT DEFAULT 'carteira',
      status TEXT DEFAULT 'pendente',  -- pendente | pago | cancelado
      vencimento TEXT,
      data_pagamento TEXT,
      forma_recebimento TEXT,
      referencia TEXT,
      observacao TEXT,
      created_date TEXT,
      updated_date TEXT,
      synced_at TEXT
    );

    -- Fila de sync (operações offline pendentes)
    CREATE TABLE IF NOT EXISTS sync_queue (
      id TEXT PRIMARY KEY,
      entidade TEXT NOT NULL, -- venda | estoque | credito
      operacao TEXT NOT NULL, -- create | update | delete
      payload TEXT NOT NULL, -- JSON
      tentativas INTEGER DEFAULT 0,
      erro TEXT,
      created_at TEXT NOT NULL,
      processado INTEGER DEFAULT 0
    );

    -- Vendedores
    CREATE TABLE IF NOT EXISTS vendedores (
      id TEXT PRIMARY KEY,
      codigo TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL,
      comissao REAL DEFAULT 0,
      ativo INTEGER DEFAULT 1,
      updated_date TEXT
    );

    -- Faltas / Encomendas
    CREATE TABLE IF NOT EXISTS faltas (
      id TEXT PRIMARY KEY,
      remote_id TEXT UNIQUE,
      produto_id TEXT,
      produto_nome TEXT NOT NULL,
      produto_sku TEXT,
      cliente_nome TEXT,
      cliente_telefone TEXT,
      quantidade_solicitada REAL DEFAULT 1,
      observacao TEXT,
      status TEXT DEFAULT 'pendente',
      origem TEXT DEFAULT 'pdv',
      usuario_nome TEXT,
      created_at TEXT NOT NULL,
      synced_at TEXT,
      sync_status TEXT DEFAULT 'pending'
    );

    -- Entregas
    CREATE TABLE IF NOT EXISTS entregas (
      id TEXT PRIMARY KEY,
      remote_id TEXT UNIQUE,
      empresa_id TEXT,
      empresa_nome TEXT,
      venda_id TEXT,
      venda_numero INTEGER,
      terminal_id TEXT,
      numero_local TEXT,
      cliente_id TEXT,
      cliente_nome TEXT,
      cliente_telefone TEXT,
      cliente_whatsapp TEXT,
      cep TEXT,
      logradouro TEXT,
      numero TEXT,
      complemento TEXT,
      bairro TEXT,
      cidade TEXT,
      estado TEXT,
      observacao TEXT,
      data_agendada TEXT,
      turno TEXT DEFAULT 'qualquer',
      itens TEXT,
      valor_total_entrega REAL DEFAULT 0,
      status TEXT DEFAULT 'pendente',
      transportadora TEXT,
      codigo_rastreio TEXT,
      motorista_nome TEXT,
      veiculo_placa TEXT,
      observacao_entrega TEXT,
      data_saida TEXT,
      data_entrega TEXT,
      criado_por TEXT,
      created_at TEXT NOT NULL,
      synced_at TEXT,
      sync_status TEXT DEFAULT 'pending'
    );

    -- Orçamentos
    CREATE TABLE IF NOT EXISTS orcamentos (
      id TEXT PRIMARY KEY,
      remote_id TEXT UNIQUE,
      numero INTEGER,
      status TEXT DEFAULT 'pendente',
      cliente_id TEXT,
      cliente_nome TEXT,
      cliente_telefone TEXT,
      vendedor_nome TEXT,
      forma_pagamento TEXT DEFAULT 'dinheiro',
      validade_dias INTEGER DEFAULT 7,
      subtotal REAL NOT NULL DEFAULT 0,
      desconto REAL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      observacao TEXT,
      created_at TEXT NOT NULL,
      synced_at TEXT,
      sync_status TEXT DEFAULT 'pending'
    );

    CREATE TABLE IF NOT EXISTS orcamento_itens (
      id TEXT PRIMARY KEY,
      orcamento_id TEXT NOT NULL,
      produto_id TEXT,
      produto_nome TEXT,
      produto_sku TEXT,
      quantidade REAL NOT NULL,
      preco_unitario REAL NOT NULL,
      desconto REAL DEFAULT 0,
      total REAL NOT NULL,
      FOREIGN KEY (orcamento_id) REFERENCES orcamentos(id)
    );

    -- Config local
    CREATE TABLE IF NOT EXISTS config (
      chave TEXT PRIMARY KEY,
      valor TEXT
    );
  `);
}

function runMigrations() {
  // Adiciona colunas novas sem quebrar banco existente
  const migrations = [
    'ALTER TABLE produtos ADD COLUMN disponivel_pdv INTEGER DEFAULT 1',
    'ALTER TABLE vendas ADD COLUMN vendedor_id TEXT',
    'ALTER TABLE vendas ADD COLUMN vendedor_nome TEXT',
    'ALTER TABLE vendas ADD COLUMN vendedor_codigo TEXT',
    `CREATE TABLE IF NOT EXISTS faltas (
      id TEXT PRIMARY KEY, remote_id TEXT UNIQUE,
      produto_id TEXT, produto_nome TEXT NOT NULL, produto_sku TEXT,
      cliente_nome TEXT, cliente_telefone TEXT,
      quantidade_solicitada REAL DEFAULT 1, observacao TEXT,
      status TEXT DEFAULT 'pendente', origem TEXT DEFAULT 'pdv',
      usuario_nome TEXT, created_at TEXT NOT NULL,
      synced_at TEXT, sync_status TEXT DEFAULT 'pending'
    )`,
    'ALTER TABLE clientes ADD COLUMN saldo_devedor REAL DEFAULT 0',
    'ALTER TABLE clientes ADD COLUMN status_credito TEXT DEFAULT \'liberado\'',
    'ALTER TABLE clientes ADD COLUMN permite_carteira INTEGER DEFAULT 0',
    `CREATE TABLE IF NOT EXISTS contas_receber (
      id TEXT PRIMARY KEY, empresa_id TEXT, cliente_id TEXT, cliente_nome TEXT,
      valor REAL NOT NULL DEFAULT 0, descricao TEXT, origem TEXT DEFAULT 'carteira',
      status TEXT DEFAULT 'pendente', vencimento TEXT, data_pagamento TEXT,
      forma_recebimento TEXT, referencia TEXT, observacao TEXT,
      created_date TEXT, updated_date TEXT, synced_at TEXT
    )`,
    'ALTER TABLE vendas ADD COLUMN updated_at TEXT',
    'ALTER TABLE entregas ADD COLUMN referencia TEXT',
    'ALTER TABLE entregas ADD COLUMN cliente_documento TEXT',
    'ALTER TABLE produtos ADD COLUMN emoji TEXT DEFAULT \'📦\'',
    'ALTER TABLE clientes ADD COLUMN whatsapp TEXT',
    'ALTER TABLE clientes ADD COLUMN cep TEXT',
    'ALTER TABLE clientes ADD COLUMN logradouro TEXT',
    'ALTER TABLE clientes ADD COLUMN numero TEXT',
    'ALTER TABLE clientes ADD COLUMN complemento TEXT',
    'ALTER TABLE clientes ADD COLUMN bairro TEXT',
    'ALTER TABLE clientes ADD COLUMN cidade TEXT',
    'ALTER TABLE clientes ADD COLUMN estado TEXT',
    'ALTER TABLE clientes ADD COLUMN referencia TEXT',
    'ALTER TABLE clientes ADD COLUMN obs_entrega TEXT',
    'ALTER TABLE produtos ADD COLUMN ncm TEXT',
    'ALTER TABLE produtos ADD COLUMN cfop TEXT DEFAULT \'5102\'',
    'ALTER TABLE produtos ADD COLUMN icms_cst TEXT DEFAULT \'400\'',
    'ALTER TABLE produtos ADD COLUMN icms_origem INTEGER DEFAULT 0',
    'ALTER TABLE produtos ADD COLUMN pis_cst TEXT DEFAULT \'07\'',
    'ALTER TABLE produtos ADD COLUMN cofins_cst TEXT DEFAULT \'07\'',
    `CREATE TABLE IF NOT EXISTS entregas (
      id TEXT PRIMARY KEY, remote_id TEXT UNIQUE,
      empresa_id TEXT, empresa_nome TEXT, venda_id TEXT, venda_numero INTEGER,
      terminal_id TEXT, numero_local TEXT, cliente_id TEXT, cliente_nome TEXT,
      cliente_telefone TEXT, cliente_whatsapp TEXT, cliente_documento TEXT,
      cep TEXT, logradouro TEXT, numero TEXT, complemento TEXT,
      bairro TEXT, cidade TEXT, estado TEXT, referencia TEXT, observacao TEXT,
      data_agendada TEXT, turno TEXT DEFAULT 'qualquer', itens TEXT,
      valor_total_entrega REAL DEFAULT 0,
      status TEXT DEFAULT 'pendente', transportadora TEXT, codigo_rastreio TEXT,
      motorista_nome TEXT, veiculo_placa TEXT, observacao_entrega TEXT,
      data_saida TEXT, data_entrega TEXT, criado_por TEXT,
      created_at TEXT NOT NULL, synced_at TEXT, sync_status TEXT DEFAULT 'pending'
    )`,
    `CREATE TABLE IF NOT EXISTS marketplace_anuncios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conta_id TEXT NOT NULL,
      canal TEXT NOT NULL DEFAULT 'shopee',
      item_id TEXT NOT NULL,
      nome TEXT,
      status TEXT DEFAULT 'NORMAL',
      preco REAL,
      estoque INTEGER,
      vendas INTEGER DEFAULT 0,
      rating REAL,
      imagem_url TEXT,
      dados_json TEXT,
      sincronizado_em TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(conta_id, item_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_mkt_anuncios_conta ON marketplace_anuncios(conta_id)',
    'CREATE INDEX IF NOT EXISTS idx_mkt_anuncios_nome ON marketplace_anuncios(nome)',
    // Colunas de mapeamento (migrations seguras)
    'ALTER TABLE marketplace_anuncios ADD COLUMN produto_id TEXT',
    'ALTER TABLE marketplace_anuncios ADD COLUMN produto_nome TEXT',
    'ALTER TABLE marketplace_anuncios ADD COLUMN produto_sku TEXT',
    'ALTER TABLE marketplace_anuncios ADD COLUMN status_mapeamento TEXT DEFAULT \'pendente_mapeamento\'',
    'ALTER TABLE marketplace_anuncios ADD COLUMN base44_id TEXT',
    'ALTER TABLE marketplace_anuncios ADD COLUMN mapeado_em TEXT',
    `CREATE TABLE IF NOT EXISTS marketplace_pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conta_id TEXT NOT NULL,
      canal TEXT NOT NULL DEFAULT 'shopee',
      pedido_id TEXT NOT NULL,
      status_shopee TEXT,
      status_pagamento TEXT,
      cliente_nome TEXT,
      cliente_telefone TEXT,
      endereco_entrega TEXT,
      cliente_cidade TEXT,
      cliente_estado TEXT,
      valor_total REAL,
      valor_produtos REAL,
      valor_frete REAL,
      valor_desconto REAL,
      transportadora TEXT,
      metodo_envio TEXT,
      codigo_rastreio TEXT,
      shipping_id TEXT,
      data_pedido TEXT,
      data_prazo_envio TEXT,
      itens_json TEXT,
      dados_json TEXT,
      base44_id TEXT,
      base44_status TEXT DEFAULT 'pendente',
      importado_em TEXT NOT NULL DEFAULT (datetime('now')),
      atualizado_em TEXT,
      UNIQUE(conta_id, pedido_id)
    )`,
    'CREATE INDEX IF NOT EXISTS idx_mkt_pedidos_conta ON marketplace_pedidos(conta_id)',
    'CREATE INDEX IF NOT EXISTS idx_mkt_pedidos_base44 ON marketplace_pedidos(base44_status)',
    'ALTER TABLE vendas ADD COLUMN nfce_emitida INTEGER DEFAULT 0',
    'ALTER TABLE vendas ADD COLUMN nfce_chave TEXT',
    'ALTER TABLE vendas ADD COLUMN nfce_numero TEXT',
    'ALTER TABLE vendas ADD COLUMN nfce_serie TEXT',
    'ALTER TABLE vendas ADD COLUMN nfce_url_pdf TEXT',
    'ALTER TABLE vendas ADD COLUMN nfce_referencia TEXT',
    `CREATE TABLE IF NOT EXISTS orcamentos (
      id TEXT PRIMARY KEY, remote_id TEXT UNIQUE, numero INTEGER,
      status TEXT DEFAULT 'pendente', cliente_id TEXT,
      cliente_nome TEXT, cliente_telefone TEXT, vendedor_nome TEXT,
      forma_pagamento TEXT DEFAULT 'dinheiro', validade_dias INTEGER DEFAULT 7,
      subtotal REAL NOT NULL DEFAULT 0, desconto REAL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
      observacao TEXT, created_at TEXT NOT NULL, synced_at TEXT, sync_status TEXT DEFAULT 'pending'
    )`,
    `CREATE TABLE IF NOT EXISTS orcamento_itens (
      id TEXT PRIMARY KEY, orcamento_id TEXT NOT NULL,
      produto_id TEXT, produto_nome TEXT, produto_sku TEXT,
      quantidade REAL NOT NULL, preco_unitario REAL NOT NULL,
      desconto REAL DEFAULT 0, total REAL NOT NULL,
      FOREIGN KEY (orcamento_id) REFERENCES orcamentos(id)
    )`,
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch { /* coluna já existe */ }
  }
}

function createIndexes() {
  db.exec(`
    -- Índices críticos para busca de 14k produtos em <50ms
    CREATE INDEX IF NOT EXISTS idx_produtos_nome_lower ON produtos(nome_lower);
    CREATE INDEX IF NOT EXISTS idx_produtos_ean ON produtos(ean);
    CREATE INDEX IF NOT EXISTS idx_produtos_sku ON produtos(sku);
    CREATE INDEX IF NOT EXISTS idx_produtos_ativo ON produtos(ativo);
    CREATE INDEX IF NOT EXISTS idx_produtos_categoria ON produtos(categoria);

    -- Índices clientes
    CREATE INDEX IF NOT EXISTS idx_clientes_nome_lower ON clientes(nome_lower);
    CREATE INDEX IF NOT EXISTS idx_clientes_cpf ON clientes(cpf_cnpj);
    CREATE INDEX IF NOT EXISTS idx_creditos_cliente_id ON creditos_cliente(cliente_id);
    CREATE INDEX IF NOT EXISTS idx_creditos_status ON creditos_cliente(status);

    -- Índices estoque
    CREATE INDEX IF NOT EXISTS idx_estoque_produto ON estoque(produto_id);

    -- Índices vendas
    CREATE INDEX IF NOT EXISTS idx_vendas_created ON vendas(created_at);
    CREATE INDEX IF NOT EXISTS idx_vendas_sync ON vendas(sync_status);
    CREATE INDEX IF NOT EXISTS idx_vendas_cliente ON vendas(cliente_id);

    -- Fila sync
    CREATE INDEX IF NOT EXISTS idx_queue_processado ON sync_queue(processado);
  `);
}

// ─── PRODUTOS ─────────────────────────────────────────────────────
const produtos = {
  // Busca full-text otimizada — retorna max 100 resultados
  buscar(query) {
    // Apenas produtos ativos E disponíveis no PDV
    const filtroBase = 'p.ativo = 1 AND p.disponivel_pdv = 1';

    if (!query || query.trim() === '') {
      return db.prepare(`
        SELECT p.*, e.quantidade as estoque
        FROM produtos p
        LEFT JOIN estoque e ON e.produto_id = p.id
        WHERE ${filtroBase}
        ORDER BY p.nome LIMIT 100
      `).all();
    }
    const q = query.trim().toLowerCase();
    // Busca por EAN primeiro (digitação de código de barras)
    if (/^\d{8,14}$/.test(query.trim())) {
      const byEan = db.prepare(`
        SELECT p.*, e.quantidade as estoque
        FROM produtos p
        LEFT JOIN estoque e ON e.produto_id = p.id
        WHERE p.ean = ? AND ${filtroBase} LIMIT 1
      `).get(query.trim());
      if (byEan) return [byEan];
    }
    // Quebrar em palavras e exigir que o nome contenha TODAS elas
    const palavras = q.split(/\s+/).filter(Boolean);

    if (palavras.length <= 1) {
      return db.prepare(`
        SELECT p.*, e.quantidade as estoque
        FROM produtos p
        LEFT JOIN estoque e ON e.produto_id = p.id
        WHERE ${filtroBase} AND (
          p.nome_lower LIKE ? OR
          p.sku LIKE ? OR
          p.ean LIKE ? OR
          p.marca LIKE ?
        )
        ORDER BY
          CASE WHEN p.nome_lower LIKE ? THEN 0 ELSE 1 END,
          p.nome
        LIMIT 100
      `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `${q}%`);
    }

    // Busca multi-palavra: monta condição AND para cada palavra no nome
    const nomeConditions = palavras.map(() => `p.nome_lower LIKE ?`).join(' AND ');
    const nomeParams = palavras.map(p => `%${p}%`);

    const sql = `
      SELECT p.*, e.quantidade as estoque
      FROM produtos p
      LEFT JOIN estoque e ON e.produto_id = p.id
      WHERE ${filtroBase} AND (
        (${nomeConditions}) OR
        p.sku LIKE ? OR
        p.ean LIKE ?
      )
      ORDER BY
        CASE WHEN p.nome_lower LIKE ? THEN 0 ELSE 1 END,
        p.nome
      LIMIT 100
    `;
    return db.prepare(sql).all(...nomeParams, `%${q}%`, `%${q}%`, `${palavras[0]}%`);
  },

  getById(id) {
    return db.prepare(`
      SELECT p.*, e.quantidade as estoque, e.quantidade_minima
      FROM produtos p
      LEFT JOIN estoque e ON e.produto_id = p.id
      WHERE p.id = ?
    `).get(id);
  },

  getByEan(ean) {
    return db.prepare(`
      SELECT p.*, e.quantidade as estoque
      FROM produtos p
      LEFT JOIN estoque e ON e.produto_id = p.id
      WHERE p.ean = ? AND p.ativo = 1 LIMIT 1
    `).get(ean);
  },

  // Busca para tela de gestão — inclui produtos fora do PDV
  buscarGestao(query) {
    const filtro = 'p.ativo = 1';
    if (!query || query.trim() === '') {
      return db.prepare(`
        SELECT p.*, e.quantidade as estoque
        FROM produtos p
        LEFT JOIN estoque e ON e.produto_id = p.id
        WHERE ${filtro}
        ORDER BY p.nome LIMIT 500
      `).all();
    }
    const q = query.trim().toLowerCase();
    const palavras = q.split(/\s+/).filter(Boolean);
    if (palavras.length <= 1) {
      return db.prepare(`
        SELECT p.*, e.quantidade as estoque
        FROM produtos p
        LEFT JOIN estoque e ON e.produto_id = p.id
        WHERE ${filtro} AND (p.nome_lower LIKE ? OR p.sku LIKE ? OR p.ean LIKE ? OR p.marca LIKE ?)
        ORDER BY CASE WHEN p.nome_lower LIKE ? THEN 0 ELSE 1 END, p.nome LIMIT 500
      `).all(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `${q}%`);
    }
    const conds = palavras.map(() => `p.nome_lower LIKE ?`).join(' AND ');
    const params = palavras.map(w => `%${w}%`);
    return db.prepare(`
      SELECT p.*, e.quantidade as estoque
      FROM produtos p
      LEFT JOIN estoque e ON e.produto_id = p.id
      WHERE ${filtro} AND ${conds}
      ORDER BY p.nome LIMIT 500
    `).all(...params);
  },

  total() {
    return db.prepare('SELECT COUNT(*) as total FROM produtos WHERE ativo = 1').get().total;
  },

  salvar(produto) {
    const id = produto.id || uuidv4();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO produtos
      (id, remote_id, nome, nome_lower, sku, ean, preco_venda, preco_custo,
       unidade, categoria, marca, foto_url, ativo, permite_fracao, updated_at, sync_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, produto.remote_id || null,
      produto.nome, produto.nome?.toLowerCase(),
      produto.sku || null, produto.ean || null,
      produto.preco_venda || 0, produto.preco_custo || 0,
      produto.unidade || 'UN', produto.categoria || null,
      produto.marca || null, produto.foto_url || null,
      produto.ativo !== false ? 1 : 0,
      produto.permite_fracao ? 1 : 0,
      now, 'pending'
    );
    return id;
  },

  atualizar(id, dados) {
    const sets = Object.keys(dados).map(k => `${k} = ?`).join(', ');
    const vals = Object.values(dados);
    if (dados.nome) { vals.push(dados.nome.toLowerCase()); }
    db.prepare(`UPDATE produtos SET ${sets}${dados.nome ? ', nome_lower = ?' : ''}, updated_at = ?, sync_status = 'pending' WHERE id = ?`)
      .run(...vals, new Date().toISOString(), id);
    return true;
  },

  // Upsert em lote para sync
  upsertBatch(lista) {
    const stmtInsert = db.prepare(`
      INSERT OR IGNORE INTO produtos
      (id, remote_id, nome, nome_lower, sku, ean, preco_venda, preco_custo,
       unidade, categoria, marca, foto_url, ativo, disponivel_pdv, permite_fracao,
       ncm, cfop, icms_cst, icms_origem, pis_cst, cofins_cst,
       updated_at, synced_at, sync_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    // UPDATE que preserva campos fiscais locais quando pendentes
    const stmtUpdate = db.prepare(`
      UPDATE produtos SET
        nome = ?, nome_lower = ?, sku = ?, ean = ?,
        preco_venda = ?, preco_custo = ?, unidade = ?,
        categoria = ?, marca = ?, foto_url = ?,
        ativo = ?, disponivel_pdv = ?, permite_fracao = ?,
        ncm        = CASE WHEN sync_status = 'pending' THEN ncm        ELSE ? END,
        cfop       = CASE WHEN sync_status = 'pending' THEN cfop       ELSE ? END,
        icms_cst   = CASE WHEN sync_status = 'pending' THEN icms_cst   ELSE ? END,
        icms_origem= CASE WHEN sync_status = 'pending' THEN icms_origem ELSE ? END,
        pis_cst    = CASE WHEN sync_status = 'pending' THEN pis_cst    ELSE ? END,
        cofins_cst = CASE WHEN sync_status = 'pending' THEN cofins_cst ELSE ? END,
        updated_at = ?, synced_at = ?,
        sync_status = CASE WHEN sync_status = 'pending' THEN 'pending' ELSE 'synced' END
      WHERE remote_id = ?
    `);
    const stmtEst = db.prepare(`
      INSERT OR REPLACE INTO estoque (id, produto_id, quantidade, quantidade_minima, updated_at)
      VALUES (
        COALESCE((SELECT id FROM estoque WHERE produto_id = ?), ?),
        ?, ?, ?, ?
      )
    `);
    const stmtGetId = db.prepare('SELECT id FROM produtos WHERE remote_id = ?');

    const transaction = db.transaction((items) => {
      for (const p of items) {
        const existing = stmtGetId.get(p.id);
        const localId = existing?.id || uuidv4();
        const now = new Date().toISOString();
        const ncm     = p.ncm       || null;
        const cfop    = p.cfop      || null;
        const icmsCst = p.icms_cst  || null;
        const icmsOri = p.icms_origem !== undefined ? p.icms_origem : 0;
        const pisCst  = p.pis_cst   || null;
        const cofCst  = p.cofins_cst|| null;

        stmtInsert.run(
          localId, p.id,
          p.nome, p.nome?.toLowerCase(),
          p.sku || null, p.ean || null,
          p.preco_venda || 0, p.preco_custo || 0,
          p.unidade || 'UN', p.categoria || null,
          p.marca || null, p.foto_url || null,
          p.ativo !== false ? 1 : 0,
          p.disponivel_pdv !== false ? 1 : 0,
          p.permite_fracao ? 1 : 0,
          ncm, cfop, icmsCst, icmsOri, pisCst, cofCst,
          p.updated_at || now, now, 'synced'
        );

        stmtUpdate.run(
          p.nome, p.nome?.toLowerCase(),
          p.sku || null, p.ean || null,
          p.preco_venda || 0, p.preco_custo || 0,
          p.unidade || 'UN', p.categoria || null,
          p.marca || null, p.foto_url || null,
          p.ativo !== false ? 1 : 0,
          p.disponivel_pdv !== false ? 1 : 0,
          p.permite_fracao ? 1 : 0,
          ncm, cfop, icmsCst, icmsOri, pisCst, cofCst,
          p.updated_at || now, now,
          p.id
        );

        if (p.estoque !== undefined && p.estoque !== null) {
          const pid = stmtGetId.get(p.id)?.id || localId;
          stmtEst.run(pid, uuidv4(), pid, p.estoque, p.estoque_minimo || 0, now);
        }
      }
    });
    transaction(lista);
  }
};

// ─── CLIENTES ─────────────────────────────────────────────────────
const clientes = {
  buscar(query) {
    if (!query) return db.prepare('SELECT * FROM clientes ORDER BY nome LIMIT 50').all();
    const q = query.toLowerCase();
    return db.prepare(`
      SELECT * FROM clientes
      WHERE nome_lower LIKE ? OR cpf_cnpj LIKE ? OR telefone LIKE ?
      ORDER BY nome LIMIT 50
    `).all(`%${q}%`, `%${q}%`, `%${q}%`);
  },

  getById(id) {
    return db.prepare('SELECT * FROM clientes WHERE id = ?').get(id);
  },

  getCredito(clienteId) {
    const cliente = db.prepare('SELECT limite_credito, saldo_credito FROM clientes WHERE id = ?').get(clienteId);
    const movs = db.prepare('SELECT * FROM credito_movimentacoes WHERE cliente_id = ? ORDER BY created_at DESC LIMIT 20').all(clienteId);
    return { ...cliente, movimentacoes: movs };
  },

  salvar(cliente) {
    const id = cliente.id || uuidv4();
    const existente = cliente.id
      ? db.prepare('SELECT remote_id FROM clientes WHERE id = ?').get(cliente.id)
      : null;
    const remoteId = cliente.remote_id || existente?.remote_id || null;

    db.prepare(`
      INSERT OR REPLACE INTO clientes
      (id, remote_id, nome, nome_lower, cpf_cnpj, telefone, email, limite_credito, saldo_credito,
       saldo_devedor, status_credito, permite_carteira, updated_at, sync_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, remoteId,
      cliente.nome, cliente.nome?.toLowerCase(),
      cliente.cpf_cnpj || null, cliente.telefone || null, cliente.email || null,
      cliente.limite_credito || 0, cliente.saldo_credito || 0,
      cliente.saldo_devedor || 0, cliente.status_credito || 'liberado', cliente.permite_carteira ? 1 : 0,
      new Date().toISOString(), remoteId ? 'synced' : 'pending'
    );

    // Agendar upload para Base44 se ainda não tem remote_id
    if (!remoteId) {
      const jaNaFila = db.prepare(
        "SELECT id FROM sync_queue WHERE entidade='cliente' AND payload LIKE ? AND processado=0"
      ).get(`%${id}%`);
      if (!jaNaFila) {
        db.prepare(`INSERT INTO sync_queue (id, entidade, operacao, payload, created_at) VALUES (?,?,?,?,?)`)
          .run(uuidv4(), 'cliente', 'create', JSON.stringify({ cliente_id: id }), new Date().toISOString());
      }
    }

    return id;
  },

  upsertBatch(lista) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO clientes
      (id, remote_id, nome, nome_lower, cpf_cnpj, telefone, whatsapp, email,
       cep, logradouro, numero, complemento, bairro, cidade, estado, referencia, obs_entrega,
       limite_credito, saldo_credito, saldo_devedor, status_credito, permite_carteira,
       updated_at, synced_at, sync_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const t = db.transaction(items => {
      for (const c of items) {
        stmt.run(
          c.local_id || uuidv4(), c.id, c.nome, c.nome?.toLowerCase(),
          c.cpf_cnpj || null, c.telefone || null, c.whatsapp || null, c.email || null,
          c.cep || null, c.logradouro || null, c.numero || null, c.complemento || null,
          c.bairro || null, c.cidade || null, c.estado || null, c.referencia || null, c.obs_entrega || null,
          c.limite_credito || 0, c.saldo_credito || 0,
          c.saldo_devedor || 0, c.status_credito || 'liberado', c.permite_carteira ? 1 : 0,
          c.updated_at || new Date().toISOString(), new Date().toISOString(), 'synced'
        );
      }
    });
    t(lista);
  },

  atualizarEndereco(remoteId, dados) {
    const campos = ['telefone','whatsapp','cep','logradouro','numero','complemento','bairro','cidade','estado','referencia','obs_entrega'];
    const sets = campos.filter(c => dados[c]).map(c => `${c} = ?`).join(', ');
    const vals = campos.filter(c => dados[c]).map(c => dados[c]);
    if (!sets) return;
    vals.push(remoteId);
    db.prepare(`UPDATE clientes SET ${sets} WHERE remote_id = ?`).run(...vals);
  }
};

// ─── VENDEDORES ───────────────────────────────────────────────────
const vendedores = {
  upsertBatch(lista) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO vendedores (id, codigo, nome, comissao, ativo, updated_date)
      VALUES (?,?,?,?,?,?)
    `);
    const t = db.transaction(items => {
      for (const v of items) {
        stmt.run(v.id, v.codigo, v.nome, v.comissao || 0, v.ativo !== false ? 1 : 0, v.updated_date || null);
      }
    });
    t(lista);
  },

  getByCodigo(codigo) {
    return db.prepare('SELECT * FROM vendedores WHERE codigo = ? AND ativo = 1').get(codigo);
  },

  listar() {
    return db.prepare('SELECT * FROM vendedores WHERE ativo = 1 ORDER BY nome').all();
  }
};

// ─── CONTAS A RECEBER (Fiado / Carteira) ─────────────────────────
const contasReceber = {
  upsertBatch(lista) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO contas_receber
      (id, empresa_id, cliente_id, cliente_nome, valor, descricao,
       origem, status, vencimento, data_pagamento, forma_recebimento,
       referencia, observacao, created_date, updated_date, synced_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const t = db.transaction(items => {
      for (const c of items) {
        stmt.run(
          c.id, c.empresa_id || null,
          c.cliente_id || null, c.cliente_nome || null,
          c.valor || 0, c.descricao || null,
          c.origem || 'carteira', c.status || 'pendente',
          c.vencimento || null, c.data_pagamento || null, c.forma_recebimento || null,
          c.referencia || null, c.observacao || null,
          c.created_date || null, c.updated_date || null,
          new Date().toISOString()
        );
      }
    });
    t(lista);
  },

  // Contas pendentes de um cliente
  getContasAbertas(clienteRemoteId) {
    return db.prepare(`
      SELECT id, valor, descricao, origem, status, vencimento, data_pagamento, referencia, observacao, created_date
      FROM contas_receber
      WHERE cliente_id = ? AND status = 'pendente'
      ORDER BY vencimento ASC, created_date ASC
    `).all(clienteRemoteId);
  },

  // Marcar como pago localmente
  marcarPago(id, formaPagamento, obs) {
    db.prepare(`
      UPDATE contas_receber
      SET status = 'pago', data_pagamento = ?, forma_recebimento = ?, observacao = ?, updated_date = ?
      WHERE id = ?
    `).run(new Date().toISOString().split('T')[0], formaPagamento || 'dinheiro', obs || null, new Date().toISOString(), id);
  },

  // Atualizar valor para pagamento parcial (mantém como pendente)
  atualizarValor(id, novoValor, obs) {
    db.prepare(`
      UPDATE contas_receber SET valor = ?, observacao = ?, updated_date = ? WHERE id = ?
    `).run(novoValor, obs || null, new Date().toISOString(), id);
  }
};

// ─── CRÉDITOS CLIENTE (Crédito Loja / Devoluções) ─────────────────
const creditosCliente = {
  limparTodos() {
    // Usado no re-sync forçado: remove registros obsoletos antes de re-inserir
    db.prepare(`DELETE FROM creditos_cliente`).run();
  },

  upsertBatch(lista) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO creditos_cliente
      (id, empresa_id, cliente_id, cliente_nome, cliente_telefone,
       venda_origem_id, venda_origem_numero,
       valor_original, saldo_atual, status, origem, observacao, created_date, updated_date)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const t = db.transaction(items => {
      for (const c of items) {
        stmt.run(
          c.id, c.empresa_id || null,
          c.cliente_id || null, c.cliente_nome || null, c.cliente_telefone || null,
          c.venda_origem_id || null, c.venda_origem_numero || null,
          c.valor_original || 0, c.saldo_atual ?? c.valor_original ?? 0,
          c.status || 'aberto', c.origem || null, c.observacao || null,
          c.created_date || null, c.updated_date || null
        );
      }
    });
    t(lista);
  },

  // Retorna todos os créditos abertos de um cliente (remote_id)
  getAbertosDoCliente(clienteRemoteId) {
    return db.prepare(`
      SELECT * FROM creditos_cliente
      WHERE cliente_id = ? AND status IN ('aberto', 'usado_parcialmente')
      ORDER BY created_date ASC
    `).all(clienteRemoteId);
  },

  // Zerar crédito localmente após uso
  marcarUsado(creditoId) {
    db.prepare(`UPDATE creditos_cliente SET saldo_atual = 0, status = 'usado_totalmente' WHERE id = ?`).run(creditoId);
  },

  // Resumo de créditos por cliente para mostrar na lista
  resumoPorCliente(clienteRemoteId) {
    return db.prepare(`
      SELECT
        COUNT(*) as total_registros,
        SUM(saldo_atual) as total_saldo,
        SUM(valor_original) as total_original
      FROM creditos_cliente
      WHERE cliente_id = ? AND status IN ('aberto', 'usado_parcialmente')
    `).get(clienteRemoteId) || { total_registros: 0, total_saldo: 0, total_original: 0 };
  },

  // Atualizar saldo local após recebimento
  atualizarSaldo(remoteId, novoSaldo, novoStatus) {
    db.prepare(`
      UPDATE creditos_cliente SET saldo_atual = ?, status = ?, updated_date = ? WHERE id = ?
    `).run(novoSaldo, novoStatus, new Date().toISOString(), remoteId);
  },

  // ─── Carteira de Clientes ────────────────────────────────────────
  // Resumo geral para o header
  resumoGeral() {
    const totais = db.prepare(`
      SELECT
        COUNT(DISTINCT cliente_id) as total_clientes,
        COALESCE(SUM(valor), 0)    as total_a_receber
      FROM contas_receber
      WHERE status = 'pendente'
    `).get() || { total_clientes: 0, total_a_receber: 0 };

    // Vencido: clientes com dívida e prazo ultrapassado 30 dias (simplificado)
    const vencido = db.prepare(`
      SELECT COALESCE(SUM(cr.saldo_atual), 0) as total_vencido
      FROM creditos_cliente cr
      WHERE cr.status IN ('aberto', 'usado_parcialmente')
        AND julianday('now') - julianday(cr.created_date) > 30
    `).get()?.total_vencido || 0;

    // Crédito loja: soma dos CreditoCliente abertos (devoluções)
    const credito_loja = db.prepare(`
      SELECT COALESCE(SUM(saldo_atual), 0) as total
      FROM creditos_cliente
      WHERE status IN ('aberto', 'usado_parcialmente')
    `).get()?.total || 0;

    return { ...totais, total_vencido: vencido, credito_loja };
  },

  // Lista clientes com dívidas ou limite de crédito configurado
  listarCarteira(query = '') {
    const q = query.trim().toLowerCase();
    const filtroNome = q ? `AND (c.nome_lower LIKE '%${q}%' OR c.cpf_cnpj LIKE '%${q}%' OR c.telefone LIKE '%${q}%')` : '';
    return db.prepare(`
      SELECT
        c.remote_id,
        c.nome,
        c.telefone,
        c.cpf_cnpj,
        c.limite_credito,
        COALESCE(cr.total_a_receber, 0)      AS total_a_receber,
        COALESCE(cred.credito_loja, 0)       AS saldo_credito,
        COALESCE(cr.pendentes, 0)            AS pendentes,
        cr.vencimento_mais_antigo            AS credito_mais_antigo,
        cr.ultimo_vencimento                 AS ultimo_movimento
      FROM clientes c
      LEFT JOIN (
        SELECT
          cliente_id,
          SUM(valor)            AS total_a_receber,
          COUNT(*)              AS pendentes,
          MIN(vencimento)       AS vencimento_mais_antigo,
          MAX(vencimento)       AS ultimo_vencimento
        FROM contas_receber
        WHERE status = 'pendente'
        GROUP BY cliente_id
      ) cr ON cr.cliente_id = c.remote_id
      LEFT JOIN (
        SELECT
          cliente_id,
          SUM(saldo_atual)      AS credito_loja
        FROM creditos_cliente
        WHERE status IN ('aberto', 'usado_parcialmente')
        GROUP BY cliente_id
      ) cred ON cred.cliente_id = c.remote_id
      WHERE c.remote_id IS NOT NULL
        AND (COALESCE(cr.total_a_receber, 0) > 0 OR c.limite_credito > 0 OR COALESCE(cred.credito_loja, 0) > 0)
        ${filtroNome}
      ORDER BY COALESCE(cr.total_a_receber, 0) DESC
    `).all();
  },

  // Último pagamento registrado para o cliente (venda com forma carteira/fiado)
  ultimoPagamento(clienteRemoteId) {
    return db.prepare(`
      SELECT created_at, total, forma_pagamento
      FROM vendas
      WHERE cliente_id = (SELECT id FROM clientes WHERE remote_id = ?)
        AND forma_pagamento IN ('carteira','fiado','credito_cliente')
        AND status != 'cancelada'
      ORDER BY created_at DESC LIMIT 1
    `).get(clienteRemoteId);
  }
};

// ─── VENDAS ───────────────────────────────────────────────────────
const vendas = {
  registrar(venda) {
    const id = uuidv4();
    const now = new Date().toISOString();

    // Número sequencial com base no terminal (evita colisão entre terminais)
    const base = venda._numero_base || 0;
    const ultimoGlobal = db.prepare('SELECT MAX(numero) as num FROM vendas').get();
    const proximo = Math.max(base + 1, (ultimoGlobal?.num || 0) + 1);
    const numero = proximo;

    const registrarVenda = db.transaction(() => {
      // Inserir venda
      db.prepare(`
        INSERT INTO vendas
        (id, numero, cliente_id, empresa_id, deposito_id, operador_id, operador_nome,
         vendedor_id, vendedor_nome, vendedor_codigo,
         status, subtotal, desconto, total, forma_pagamento, valor_pago, troco, observacao, created_at, sync_status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(id, numero,
        venda.cliente_id || null, venda.empresa_id || null,
        venda.deposito_id || null, venda.operador_id || null, venda.operador_nome || null,
        venda.vendedor_id || null, venda.vendedor_nome || null, venda.vendedor_codigo || null,
        'concluida', venda.subtotal, venda.desconto || 0, venda.total,
        venda.forma_pagamento, venda.valor_pago || venda.total,
        venda.troco || 0, venda.observacao || null, now, 'pending'
      );

      // Inserir itens e baixar estoque
      for (const item of venda.itens) {
        db.prepare(`
          INSERT INTO venda_itens (id, venda_id, produto_id, produto_nome, produto_sku, quantidade, preco_unitario, desconto, total)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).run(uuidv4(), id, item.produto_id, item.produto_nome, item.produto_sku || null,
          item.quantidade, item.preco_unitario, item.desconto || 0, item.total);

        // Baixar estoque local
        const estoqueAtual = db.prepare('SELECT quantidade FROM estoque WHERE produto_id = ?').get(item.produto_id);
        const qtdAnterior = estoqueAtual?.quantidade || 0;
        const qtdPosterior = qtdAnterior - item.quantidade;

        db.prepare('UPDATE estoque SET quantidade = ? WHERE produto_id = ?')
          .run(qtdPosterior, item.produto_id);

        // Registrar movimentação
        db.prepare(`
          INSERT INTO movimentacoes_estoque
          (id, produto_id, deposito_id, tipo, quantidade, quantidade_anterior, quantidade_posterior, referencia_id, referencia_tipo, created_at, sync_status)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).run(uuidv4(), item.produto_id, venda.deposito_id || null,
          'venda', item.quantidade, qtdAnterior, qtdPosterior, id, 'venda', now, 'pending');
      }

      // Lançar crédito do cliente se necessário
      if (venda.forma_pagamento === 'credito_cliente' || venda.usa_credito) {
        const cli = db.prepare('SELECT saldo_credito FROM clientes WHERE id = ?').get(venda.cliente_id);
        if (cli) {
          const saldoAnterior = cli.saldo_credito;
          const saldoPosterior = saldoAnterior - venda.total;
          db.prepare('UPDATE clientes SET saldo_credito = ? WHERE id = ?').run(saldoPosterior, venda.cliente_id);
          db.prepare(`
            INSERT INTO credito_movimentacoes
            (id, cliente_id, venda_id, tipo, valor, saldo_anterior, saldo_posterior, created_at, sync_status)
            VALUES (?,?,?,?,?,?,?,?,?)
          `).run(uuidv4(), venda.cliente_id, id, 'debito', venda.total, saldoAnterior, saldoPosterior, now, 'pending');
        }
      }

      // Enfileirar para sync com Base44
      db.prepare(`
        INSERT INTO sync_queue (id, entidade, operacao, payload, created_at)
        VALUES (?,?,?,?,?)
      `).run(uuidv4(), 'venda', 'create', JSON.stringify({ venda_id: id }), now);
    });

    registrarVenda();
    return { id, numero };
  },

  editar(id, novosItens, novosDados) {
    const venda = this.getById(id);
    if (!venda || venda.status === 'cancelada') throw new Error('Venda não encontrada ou cancelada');
    const now = new Date().toISOString();

    const editarTx = db.transaction(() => {
      // 1. Estornar estoque dos itens ORIGINAIS
      for (const item of venda.itens) {
        db.prepare('UPDATE estoque SET quantidade = quantidade + ? WHERE produto_id = ?')
          .run(item.quantidade, item.produto_id);
      }
      // 2. Substituir itens
      db.prepare('DELETE FROM venda_itens WHERE venda_id = ?').run(id);
      for (const item of novosItens) {
        db.prepare(`
          INSERT INTO venda_itens (id, venda_id, produto_id, produto_nome, produto_sku, quantidade, preco_unitario, desconto, total)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).run(uuidv4(), id, item.produto_id, item.produto_nome, item.produto_sku || null,
          item.quantidade, item.preco_unitario, item.desconto || 0, item.total);
        // 3. Baixar estoque dos itens NOVOS
        db.prepare('UPDATE estoque SET quantidade = quantidade - ? WHERE produto_id = ?')
          .run(item.quantidade, item.produto_id);
      }
      // 4. Recalcular totais e marcar para re-sync
      const subtotal = novosItens.reduce((s, i) => s + i.total, 0);
      const desconto = novosDados.desconto || 0;
      const total = subtotal - desconto;
      db.prepare(`
        UPDATE vendas SET subtotal=?, desconto=?, total=?, forma_pagamento=?,
          valor_pago=?, troco=?, sync_status='pending', updated_at=?
        WHERE id=?
      `).run(subtotal, desconto, total,
        novosDados.forma_pagamento || venda.forma_pagamento,
        novosDados.valor_pago || total, novosDados.troco || 0, now, id);
    });

    editarTx();
    return this.getById(id);
  },

  listar(filtros = {}) {
    let where = '1=1';
    const params = [];
    if (filtros.data_inicio) { where += ' AND v.created_at >= ?'; params.push(filtros.data_inicio); }
    if (filtros.data_fim) { where += ' AND v.created_at <= ?'; params.push(filtros.data_fim + 'T23:59:59'); }
    if (filtros.cliente_id) { where += ' AND v.cliente_id = ?'; params.push(filtros.cliente_id); }
    if (filtros.status) { where += ' AND v.status = ?'; params.push(filtros.status); }
    if (filtros.produto) {
      where += ' AND EXISTS (SELECT 1 FROM venda_itens vi WHERE vi.venda_id = v.id AND vi.produto_nome LIKE ?)';
      params.push(`%${filtros.produto}%`);
    }

    return db.prepare(`
      SELECT v.*, c.nome as cliente_nome, c.telefone as cliente_telefone, c.whatsapp as cliente_whatsapp
      FROM vendas v
      LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE ${where}
      ORDER BY v.created_at DESC
      LIMIT ${filtros.limit || 200}
    `).all(...params);
  },

  getById(id) {
    const venda = db.prepare(`
      SELECT v.*, c.remote_id as cliente_remote_id
      FROM vendas v
      LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE v.id = ?
    `).get(id);
    if (!venda) return null;
    venda.itens = db.prepare('SELECT * FROM venda_itens WHERE venda_id = ?').all(id);
    return venda;
  },

  atualizarCliente(id, clienteId, nome, telefone) {
    try { db.prepare(`UPDATE vendas SET cliente_telefone=?, sync_status='pending' WHERE id=?`).run(telefone || null, id); } catch (e) { console.warn('[DB] vendas.atualizarCliente:', e.message); }
  },

  cancelar(id, motivo) {
    const venda = this.getById(id);
    if (!venda || venda.status === 'cancelada') return false;

    const cancelar = db.transaction(() => {
      db.prepare("UPDATE vendas SET status = 'cancelada', observacao = ?, sync_status = 'pending' WHERE id = ?")
        .run(motivo, id);

      // Estornar estoque
      for (const item of venda.itens) {
        db.prepare('UPDATE estoque SET quantidade = quantidade + ? WHERE produto_id = ?')
          .run(item.quantidade, item.produto_id);
        db.prepare(`
          INSERT INTO movimentacoes_estoque
          (id, produto_id, tipo, quantidade, referencia_id, referencia_tipo, observacao, created_at, sync_status)
          VALUES (?,?,'cancelamento',?,?,?,'Cancelamento de venda',?,?)
        `).run(uuidv4(), item.produto_id, item.quantidade, id, 'cancelamento', new Date().toISOString(), 'pending');
      }

      db.prepare(`INSERT INTO sync_queue (id, entidade, operacao, payload, created_at) VALUES (?,?,?,?,?)`)
        .run(uuidv4(), 'venda', 'update', JSON.stringify({ venda_id: id, status: 'cancelada', motivo }), new Date().toISOString());
    });
    cancelar();
    return true;
  },

  totaisHoje() {
    const hoje = new Date().toISOString().split('T')[0];
    return db.prepare(`
      SELECT
        COUNT(*) as total_vendas,
        SUM(total) as total_valor,
        SUM(CASE WHEN forma_pagamento = 'dinheiro' THEN total ELSE 0 END) as dinheiro,
        SUM(CASE WHEN forma_pagamento = 'pix' THEN total ELSE 0 END) as pix,
        SUM(CASE WHEN forma_pagamento IN ('credito','debito') THEN total ELSE 0 END) as cartao,
        SUM(CASE WHEN status = 'cancelada' THEN 1 ELSE 0 END) as canceladas
      FROM vendas
      WHERE created_at LIKE ? AND status != 'cancelada'
    `).get(`${hoje}%`);
  },

  atualizarNfce(id, dados) {
    db.prepare(`
      UPDATE vendas SET
        nfce_emitida = 1,
        nfce_chave = ?,
        nfce_numero = ?,
        nfce_serie = ?,
        nfce_url_pdf = ?,
        nfce_referencia = ?
      WHERE id = ?
    `).run(
      dados.chave || null,
      dados.numero ? String(dados.numero) : null,
      dados.serie ? String(dados.serie) : null,
      dados.url_pdf || null,
      dados.referencia || null,
      id
    );
  }
};

// ─── ESTOQUE ──────────────────────────────────────────────────────
const estoque = {
  get(produtoId) {
    return db.prepare('SELECT * FROM estoque WHERE produto_id = ?').get(produtoId);
  },

  movimentar(mov) {
    const atual = db.prepare('SELECT quantidade FROM estoque WHERE produto_id = ?').get(mov.produto_id);
    const qtdAnterior = atual?.quantidade || 0;
    const qtdPosterior = mov.tipo === 'entrada' ? qtdAnterior + mov.quantidade : qtdAnterior - mov.quantidade;

    db.prepare('UPDATE estoque SET quantidade = ? WHERE produto_id = ?').run(qtdPosterior, mov.produto_id);
    const id = uuidv4();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO movimentacoes_estoque
      (id, produto_id, tipo, quantidade, quantidade_anterior, quantidade_posterior, observacao, created_at, sync_status)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(id, mov.produto_id, mov.tipo, mov.quantidade, qtdAnterior, qtdPosterior, mov.observacao || null, now, 'pending');
    db.prepare('INSERT INTO sync_queue (id, entidade, operacao, payload, created_at) VALUES (?,?,?,?,?)')
      .run(uuidv4(), 'estoque', 'create', JSON.stringify({ mov_id: id }), now);
    return { id, quantidade_posterior: qtdPosterior };
  },

  alertas() {
    return db.prepare(`
      SELECT p.id, p.nome, p.sku, e.quantidade, e.quantidade_minima
      FROM estoque e
      JOIN produtos p ON p.id = e.produto_id
      WHERE e.quantidade <= e.quantidade_minima AND p.ativo = 1
      ORDER BY e.quantidade ASC LIMIT 50
    `).all();
  },

  upsertBatch(lista) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO estoque (id, produto_id, deposito_id, empresa_id, quantidade, quantidade_minima, updated_at)
      VALUES (?,?,?,?,?,?,?)
    `);
    const t = db.transaction(items => {
      for (const e of items) {
        // Buscar id local pelo produto remote_id
        const prod = db.prepare('SELECT id FROM produtos WHERE remote_id = ?').get(e.produto_id);
        if (!prod) continue;
        const existing = db.prepare('SELECT id FROM estoque WHERE produto_id = ?').get(prod.id);
        stmt.run(existing?.id || uuidv4(), prod.id, e.deposito_id || null, e.empresa_id || null,
          e.quantidade || 0, e.quantidade_minima || 0, e.updated_at || new Date().toISOString());
      }
    });
    t(lista);
  }
};

// ─── FALTAS / ENCOMENDAS ─────────────────────────────────────────
const faltas = {
  registrar(falta) {
    const id = uuidv4();
    db.prepare(`
      INSERT INTO faltas
      (id, produto_id, produto_nome, produto_sku, cliente_nome, cliente_telefone,
       quantidade_solicitada, observacao, status, origem, usuario_nome, created_at, sync_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, falta.produto_id || null, falta.produto_nome, falta.produto_sku || null,
      falta.cliente_nome || null, falta.cliente_telefone || null,
      falta.quantidade_solicitada || 1, falta.observacao || null,
      falta.status || 'pendente', falta.origem || 'pdv',
      falta.usuario_nome || null, new Date().toISOString(), 'pending'
    );
    db.prepare(`INSERT INTO sync_queue (id, entidade, operacao, payload, created_at) VALUES (?,?,?,?,?)`)
      .run(uuidv4(), 'falta', 'create', JSON.stringify({ falta_id: id }), new Date().toISOString());
    return id;
  },

  listar(filtros = {}) {
    let where = '1=1';
    const params = [];
    if (filtros.status) { where += ' AND status = ?'; params.push(filtros.status); }
    if (filtros.busca) {
      where += ' AND (produto_nome LIKE ? OR cliente_nome LIKE ?)';
      params.push(`%${filtros.busca}%`, `%${filtros.busca}%`);
    }
    return db.prepare(`
      SELECT * FROM faltas WHERE ${where}
      ORDER BY created_at DESC LIMIT ${filtros.limit || 200}
    `).all(...params);
  },

  atualizarStatus(id, status) {
    db.prepare("UPDATE faltas SET status = ?, sync_status = 'pending' WHERE id = ?").run(status, id);
    const falta = db.prepare('SELECT remote_id FROM faltas WHERE id = ?').get(id);
    if (falta?.remote_id) {
      db.prepare(`INSERT INTO sync_queue (id, entidade, operacao, payload, created_at) VALUES (?,?,?,?,?)`)
        .run(uuidv4(), 'falta', 'update', JSON.stringify({ falta_id: id, status }), new Date().toISOString());
    }
  },

  upsertFromRemote(lista) {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO faltas
      (id, remote_id, produto_id, produto_nome, produto_sku, cliente_nome, cliente_telefone,
       quantidade_solicitada, observacao, status, origem, usuario_nome, created_at, synced_at, sync_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const t = db.transaction(items => {
      for (const f of items) {
        const localId = db.prepare('SELECT id FROM faltas WHERE remote_id = ?').get(f.id)?.id || uuidv4();
        stmt.run(localId, f.id, f.produto_id || null, f.produto_nome, f.produto_sku || null,
          f.cliente_nome || null, f.cliente_telefone || null,
          f.quantidade_solicitada || 1, f.observacao || null,
          f.status || 'pendente', f.origem || 'pdv', f.usuario_nome || null,
          f.created_date || new Date().toISOString(), new Date().toISOString(), 'synced');
      }
    });
    t(lista);
  },

  contarPendentes() {
    return db.prepare("SELECT COUNT(*) as total FROM faltas WHERE status = 'pendente'").get().total;
  },
};

// ─── ENTREGAS ────────────────────────────────────────────────────
const entregas = {
  salvar(e) {
    const id = e.id || uuidv4();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT OR REPLACE INTO entregas (
        id, remote_id, empresa_id, empresa_nome, venda_id, venda_numero,
        terminal_id, numero_local, cliente_id, cliente_nome,
        cliente_telefone, cliente_whatsapp, cliente_documento,
        cep, logradouro, numero, complemento, bairro, cidade, estado,
        referencia, observacao, data_agendada, turno, itens, valor_total_entrega,
        status, criado_por, created_at, sync_status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id, e.remote_id || null, e.empresa_id || null, e.empresa_nome || null,
      e.venda_id || null, e.venda_numero || null, e.terminal_id || null, e.numero_local || null,
      e.cliente_id || null, e.cliente_nome || null,
      e.cliente_telefone || null, e.cliente_whatsapp || null, e.cliente_documento || null,
      e.cep || null, e.logradouro || null, e.numero || null, e.complemento || null,
      e.bairro || null, e.cidade || null, e.estado || null,
      e.referencia || null, e.observacao || null, e.data_agendada || null, e.turno || 'qualquer',
      typeof e.itens === 'string' ? e.itens : JSON.stringify(e.itens || []),
      e.valor_total_entrega || 0, e.status || 'pendente',
      e.criado_por || null, e.created_at || now, 'pending'
    );
    return { ...e, id };
  },

  getById(id) {
    const r = db.prepare('SELECT * FROM entregas WHERE id = ?').get(id);
    if (r && r.itens) { try { r.itens = JSON.parse(r.itens); } catch {} }
    return r;
  },

  listar(filtros = {}) {
    let where = '1=1';
    const params = [];
    if (filtros.empresa_id) { where += ' AND empresa_id = ?'; params.push(filtros.empresa_id); }
    if (filtros.status)     { where += ' AND status = ?';     params.push(filtros.status); }
    const rows = db.prepare(`SELECT * FROM entregas WHERE ${where} ORDER BY created_at DESC LIMIT 200`).all(...params);
    return rows.map(r => { try { r.itens = JSON.parse(r.itens); } catch {} return r; });
  },

  atualizar(id, dados) {
    const sets = Object.keys(dados).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE entregas SET ${sets} WHERE id = ?`).run(...Object.values(dados), id);
  },

  upsertRemote(remote) {
    const existing = db.prepare('SELECT id FROM entregas WHERE remote_id = ?').get(remote.id);
    if (existing) {
      db.prepare(`UPDATE entregas SET status=?, transportadora=?, codigo_rastreio=?,
        motorista_nome=?, veiculo_placa=?, data_saida=?, data_entrega=?, synced_at=?
        WHERE remote_id=?`).run(
        remote.status, remote.transportadora||null, remote.codigo_rastreio||null,
        remote.motorista_nome||null, remote.veiculo_placa||null,
        remote.data_saida||null, remote.data_entrega||null,
        new Date().toISOString(), remote.id
      );
    } else {
      this.salvar({ ...remote, id: uuidv4(), remote_id: remote.id, created_at: remote.created_date || new Date().toISOString() });
    }
  },
};

// ─── SYNC QUEUE ──────────────────────────────────────────────────
const syncQueue = {
  getPendentes() {
    return db.prepare(`
      SELECT * FROM sync_queue WHERE processado = 0
      ORDER BY
        CASE entidade WHEN 'cliente' THEN 0 WHEN 'venda' THEN 1 ELSE 2 END ASC,
        created_at ASC
      LIMIT 50
    `).all();
  },
  marcarProcessado(id) {
    db.prepare('UPDATE sync_queue SET processado = 1 WHERE id = ?').run(id);
  },
  marcarErro(id, erro, tentativas) {
    db.prepare('UPDATE sync_queue SET erro = ?, tentativas = ? WHERE id = ?').run(erro, tentativas, id);
  }
};

// ─── Marketplace Pedidos ───────────────────────────────────────────
const mktPedidos = {
  salvar(contaId, canal, pedido) {
    const stmt = db.prepare(`
      INSERT INTO marketplace_pedidos (
        conta_id, canal, pedido_id, status_shopee, status_pagamento,
        cliente_nome, cliente_telefone, endereco_entrega, cliente_cidade, cliente_estado,
        valor_total, valor_produtos, valor_frete, valor_desconto,
        transportadora, metodo_envio, codigo_rastreio, shipping_id,
        data_pedido, data_prazo_envio, itens_json, dados_json, atualizado_em
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
      ON CONFLICT(conta_id, pedido_id) DO UPDATE SET
        status_shopee=excluded.status_shopee, status_pagamento=excluded.status_pagamento,
        cliente_nome=excluded.cliente_nome, valor_total=excluded.valor_total,
        codigo_rastreio=excluded.codigo_rastreio, itens_json=excluded.itens_json,
        dados_json=excluded.dados_json, atualizado_em=excluded.atualizado_em
    `);
    stmt.run(
      contaId, canal, String(pedido.pedido_id),
      pedido.status_shopee || null, pedido.status_pagamento || null,
      pedido.cliente_nome || null, pedido.cliente_telefone || null,
      pedido.endereco_entrega || null, pedido.cliente_cidade || null, pedido.cliente_estado || null,
      pedido.valor_total || 0, pedido.valor_produtos || 0, pedido.valor_frete || 0, pedido.valor_desconto || 0,
      pedido.transportadora || null, pedido.metodo_envio || null,
      pedido.codigo_rastreio || null, pedido.shipping_id || null,
      pedido.data_pedido || null, pedido.data_prazo_envio || null,
      JSON.stringify(pedido.itens || []), JSON.stringify(pedido.dados_raw || {})
    );
  },

  salvarLote(contaId, canal, pedidos) {
    const tx = db.transaction(list => list.forEach(p => this.salvar(contaId, canal, p)));
    tx(pedidos);
    return pedidos.length;
  },

  listar(contaId, filtros = {}, pagina = 0, porPagina = 50) {
    const conds = ['conta_id = ?'];
    const params = [contaId];
    if (filtros.status)  { conds.push('status_shopee = ?'); params.push(filtros.status); }
    if (filtros.busca)   { conds.push('(cliente_nome LIKE ? OR pedido_id LIKE ?)'); params.push(`%${filtros.busca}%`, `%${filtros.busca}%`); }
    if (filtros.base44)  { conds.push('base44_status = ?'); params.push(filtros.base44); }
    const where = `WHERE ${conds.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) as n FROM marketplace_pedidos ${where}`).get(...params).n;
    const rows  = db.prepare(`SELECT * FROM marketplace_pedidos ${where} ORDER BY data_pedido DESC LIMIT ? OFFSET ?`).all(...params, porPagina, pagina * porPagina);
    return { rows, total, pagina, porPagina, totalPaginas: Math.ceil(total / porPagina) };
  },

  getPendentesBase44(contaId) {
    return db.prepare(`SELECT * FROM marketplace_pedidos WHERE conta_id = ? AND base44_status != 'enviado' ORDER BY data_pedido ASC`).all(contaId);
  },

  marcarEnviadoBase44(id, base44Id) {
    db.prepare(`UPDATE marketplace_pedidos SET base44_id = ?, base44_status = 'enviado', atualizado_em = datetime('now') WHERE id = ?`).run(base44Id, id);
  },

  marcarErroBase44(id, erro) {
    db.prepare(`UPDATE marketplace_pedidos SET base44_status = 'erro', atualizado_em = datetime('now') WHERE id = ?`).run(id);
  },

  getUltimaData(contaId) {
    const r = db.prepare(`SELECT MAX(data_pedido) as ultima FROM marketplace_pedidos WHERE conta_id = ?`).get(contaId);
    return r?.ultima || null;
  },

  getById(contaId, pedidoId) {
    return db.prepare('SELECT * FROM marketplace_pedidos WHERE conta_id = ? AND pedido_id = ?').get(contaId, String(pedidoId));
  },

  atualizarItens(contaId, pedidoId, itensJson, base44Status = 'pendente') {
    db.prepare(`UPDATE marketplace_pedidos SET itens_json = ?, base44_status = ?, atualizado_em = datetime('now') WHERE conta_id = ? AND pedido_id = ?`)
      .run(itensJson, base44Status, contaId, String(pedidoId));
  },
};

// ─── Marketplace Anúncios ──────────────────────────────────────────
const mktAnuncios = {
  salvarLote(contaId, canal, items) {
    const stmt = db.prepare(`
      INSERT INTO marketplace_anuncios (conta_id, canal, item_id, nome, status, preco, estoque, vendas, rating, imagem_url, dados_json, sincronizado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(conta_id, item_id) DO UPDATE SET
        nome=excluded.nome, status=excluded.status, preco=excluded.preco,
        estoque=excluded.estoque, vendas=excluded.vendas, rating=excluded.rating,
        imagem_url=excluded.imagem_url, dados_json=excluded.dados_json, sincronizado_em=excluded.sincronizado_em
    `);
    const upsertMany = db.transaction(list => list.forEach(i => stmt.run(
      contaId, canal, String(i.item_id),
      i.item_name || i.nome || null,
      i.item_status || i.status || null,
      i.price_info?.[0]?.current_price ?? i.price_info?.[0]?.original_price ?? i.preco ?? null,
      i.stock_info_v2?.summary_info?.total_available_stock ?? i.estoque ?? null,
      i.sales ?? i.vendas ?? 0,
      i.item_rating?.rating_star ?? i.rating ?? null,
      i.image?.image_url_list?.[0] ?? i.imagem_url ?? null,
      JSON.stringify(i)
    )));
    upsertMany(items);
    return items.length;
  },

  listar(contaId, busca = '', status = '', pagina = 0, porPagina = 50) {
    const conds = ['conta_id = ?'];
    const params = [contaId];
    if (status) { conds.push('status = ?'); params.push(status); }
    if (busca)  { conds.push('nome LIKE ?'); params.push(`%${busca}%`); }
    const where = `WHERE ${conds.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) as n FROM marketplace_anuncios ${where}`).get(...params).n;
    const rows  = db.prepare(`SELECT * FROM marketplace_anuncios ${where} ORDER BY nome LIMIT ? OFFSET ?`).all(...params, porPagina, pagina * porPagina);
    return { rows, total, pagina, porPagina, totalPaginas: Math.ceil(total / porPagina) };
  },

  getByItemId(contaId, itemId) {
    return db.prepare('SELECT * FROM marketplace_anuncios WHERE conta_id = ? AND item_id = ?').get(contaId, String(itemId));
  },

  salvarUm(contaId, canal, item) {
    return this.salvarLote(contaId, canal, [item]);
  },

  total(contaId) {
    return db.prepare('SELECT COUNT(*) as total, MAX(sincronizado_em) as ultima_sync FROM marketplace_anuncios WHERE conta_id = ?').get(contaId);
  },

  itemIdsExistentes(contaId) {
    return db.prepare('SELECT item_id FROM marketplace_anuncios WHERE conta_id = ?').all(contaId).map(r => r.item_id);
  },

  salvarBase44Id(contaId, itemId, base44Id) {
    db.prepare('UPDATE marketplace_anuncios SET base44_id = ? WHERE conta_id = ? AND item_id = ?').run(base44Id, contaId, String(itemId));
  },

  mapear(contaId, itemId, produtoId, produtoNome, produtoSku) {
    db.prepare(`UPDATE marketplace_anuncios SET
      produto_id = ?, produto_nome = ?, produto_sku = ?,
      status_mapeamento = 'mapeado', mapeado_em = datetime('now')
      WHERE conta_id = ? AND item_id = ?`
    ).run(produtoId, produtoNome, produtoSku || null, contaId, String(itemId));
  },

  getMapeamento(contaId, itemId) {
    return db.prepare('SELECT produto_id, produto_nome, produto_sku, status_mapeamento FROM marketplace_anuncios WHERE conta_id = ? AND item_id = ?').get(contaId, String(itemId));
  },

  getMapeamentoPorItemIds(contaId, itemIds) {
    if (!itemIds.length) return {};
    const placeholders = itemIds.map(() => '?').join(',');
    const rows = db.prepare(`SELECT item_id, produto_id, produto_nome, produto_sku, status_mapeamento FROM marketplace_anuncios WHERE conta_id = ? AND item_id IN (${placeholders})`).all(contaId, ...itemIds.map(String));
    const map = {};
    rows.forEach(r => { map[r.item_id] = r; });
    return map;
  },
};

// ─── ORÇAMENTOS ───────────────────────────────────────────────────
const orcamentos = {
  registrar(orc) {
    const id = uuidv4();
    const now = new Date().toISOString();
    const ultimo = db.prepare('SELECT MAX(numero) as n FROM orcamentos').get();
    const numero = (ultimo?.n || 0) + 1;

    db.transaction(() => {
      db.prepare(`
        INSERT INTO orcamentos
        (id, numero, status, cliente_id, cliente_nome, cliente_telefone,
         vendedor_nome, forma_pagamento, validade_dias, subtotal, desconto, total, observacao, created_at, sync_status)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id, numero, 'pendente',
        orc.cliente_id || null, orc.cliente_nome || null, orc.cliente_telefone || null,
        orc.vendedor_nome || null, orc.forma_pagamento || 'dinheiro', orc.validade_dias || 7,
        orc.subtotal || 0, orc.desconto || 0, orc.total || 0,
        orc.observacao || null, now, 'pending'
      );
      for (const item of (orc.itens || [])) {
        db.prepare(`
          INSERT INTO orcamento_itens
          (id, orcamento_id, produto_id, produto_nome, produto_sku, quantidade, preco_unitario, desconto, total)
          VALUES (?,?,?,?,?,?,?,?,?)
        `).run(
          uuidv4(), id,
          item.produto_id || null, item.produto_nome, item.produto_sku || null,
          item.quantidade, item.preco_unitario, item.desconto || 0, item.total
        );
      }
    })();

    return { id, numero };
  },

  listar(filtros = {}) {
    let where = '1=1';
    const params = [];
    if (filtros.status) { where += ' AND status = ?'; params.push(filtros.status); }
    if (filtros.busca) {
      const q = `%${filtros.busca.toLowerCase()}%`;
      where += ' AND (LOWER(cliente_nome) LIKE ? OR CAST(numero AS TEXT) LIKE ?)';
      params.push(q, q);
    }
    return db.prepare(`
      SELECT * FROM orcamentos WHERE ${where} ORDER BY created_at DESC LIMIT 200
    `).all(...params);
  },

  getById(id) {
    const orc = db.prepare('SELECT * FROM orcamentos WHERE id = ?').get(id);
    if (!orc) return null;
    orc.itens = db.prepare('SELECT * FROM orcamento_itens WHERE orcamento_id = ? ORDER BY rowid').all(id);
    return orc;
  },

  cancelar(id) {
    db.prepare(`UPDATE orcamentos SET status = 'cancelado', sync_status = 'pending' WHERE id = ?`).run(id);
  },

  atualizarRemoteId(id, remoteId) {
    db.prepare(`UPDATE orcamentos SET remote_id = ?, synced_at = ?, sync_status = 'synced' WHERE id = ?`)
      .run(remoteId, new Date().toISOString(), id);
  },

  atualizarCliente(id, clienteId, nome, telefone) {
    db.prepare(`UPDATE orcamentos SET cliente_id=?, cliente_nome=?, cliente_telefone=?, sync_status='pending' WHERE id=?`)
      .run(clienteId || null, nome || null, telefone || null, id);
  },

  marcarConvertido(id) {
    db.prepare(`UPDATE orcamentos SET status = 'convertido', sync_status = 'pending' WHERE id = ?`).run(id);
  },

  // Monta payload de sync resolvendo remote_ids dos produtos
  payloadSync(id) {
    const orc = this.getById(id);
    if (!orc) return null;
    return {
      ...orc,
      itens: orc.itens.map(i => {
        const prod = i.produto_id
          ? db.prepare('SELECT remote_id FROM produtos WHERE id = ?').get(i.produto_id)
          : null;
        return { ...i, produto_remote_id: prod?.remote_id || null };
      }),
    };
  },
};

module.exports = {
  initialize,
  db: () => db,
  produtos,
  clientes,
  vendedores,
  contasReceber,
  creditosCliente,
  vendas,
  estoque,
  faltas,
  entregas,
  orcamentos,
  sync: syncQueue,
  mktAnuncios,
  mktPedidos,
};

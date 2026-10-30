const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

let Database;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  // Mesmo database.js e SQL, SQLite real do Node para a suíte completa.
  // A suíte também é executada no Electron com better-sqlite3 nativo.
  const { DatabaseSync } = require('node:sqlite');
  Database = class {
    constructor(file) { this.raw = new DatabaseSync(file); }
    pragma(sql) { return this.raw.prepare(`PRAGMA ${sql}`).all(); }
    prepare(sql) {
      const stmt = this.raw.prepare(sql);
      return Object.fromEntries(['run', 'get', 'all'].map(method => [method,
        (...args) => stmt[method](...args.map(x => x === undefined ? null : x))]));
    }
    exec(sql) { return this.raw.exec(sql); }
    close() { this.raw.close(); }
    transaction(fn) {
      return (...args) => {
        this.exec('SAVEPOINT teste');
        try { const result = fn(...args); this.exec('RELEASE teste'); return result; }
        catch (e) { this.exec('ROLLBACK TO teste'); this.exec('RELEASE teste'); throw e; }
      };
    }
  };
}

function carregar(file, mocks) {
  const filename = path.resolve(__dirname, '../../src/main', file);
  const req = Module.createRequire(filename);
  const mod = { exports: {} };
  const executar = vm.runInThisContext(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename });
  executar(mod.exports, name => Object.hasOwn(mocks, name) ? mocks[name] : req(name), mod, filename, path.dirname(filename));
  return mod.exports;
}

const EMPRESA = '33333333-3333-4333-8333-333333333333';
const PRODUTO = '11111111-1111-4111-8111-111111111111';
const ROTA_DESLIGADA = { ok: false, motivo: 'rota_desligada', status: 409,
  corpo: { ok: false, motivo: 'rota_desligada' } };
const SEM_IDENTIDADE = { ok: false, motivo: 'sem_identidade', preWriteLocal: true };

function abrir(dir) {
  const db = carregar('database.js', {
    electron: { app: { getPath: () => dir } }, 'better-sqlite3': Database,
  });
  db.initialize();
  return db;
}

function ambiente(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-063b-'));
  const db = abrir(dir);
  t.after(() => db.db().close());
  db.db().prepare('INSERT INTO produtos (id, remote_id, nome, nome_lower, preco_venda) VALUES (?,?,?,?,?)')
    .run(PRODUTO, PRODUTO, 'TESTE', 'teste', 10);
  db.db().prepare('INSERT INTO estoque (id, produto_id, quantidade) VALUES (?,?,100)').run('est', PRODUTO);
  const venda = db.vendas.registrar({ empresa_id: EMPRESA, operador_nome: 'Operador original',
    subtotal: 10, total: 10, desconto: 0, forma_pagamento: 'dinheiro', valor_pago: 10, troco: 0,
    itens: [{ produto_id: PRODUTO, produto_nome: 'TESTE', quantidade: 1, preco_unitario: 10, desconto: 0, total: 10 }],
  });
  return { dir, db, id: venda.id };
}

function syncFalso(db, op = {}) {
  const chamadas = [];
  const config = op.config || { 'auth.usuario': { empresa_id: EMPRESA, nome: 'Operador teste' } };
  const api = new Proxy({
    montarPayloadOrcamentoRemoto: () => ({}),
    registrarVenda: async venda => {
      chamadas.push(['legado', venda.id]);
      return op.legado ? op.legado(venda) : { id: venda.id };
    },
    converterOrcamentoAutenticado: async dados => {
      chamadas.push(['arbitragem', dados]);
      return op.arbitrar ? op.arbitrar(dados) : { tipo: 'ok', estado: 'convertido', dados: { venda_id: dados.venda_id } };
    },
  }, { get(target, name) {
    if (name in target) return target[name];
    return () => { throw new Error(`Efeito remoto não autorizado no teste: api.${String(name)}`); };
  } });
  const sync = carregar('sync.js', {
    './database': db, './api': api,
    'electron-store': class { get(key) { return config[key]; } set() {} },
    './terminal': { chamarProtegida: async (rota, corpo) => {
      chamadas.push(['v1', JSON.parse(JSON.stringify(corpo))]);
      if (rota !== '/api/pdv/vendas/sincronizar-v1') throw new Error('Rota inesperada');
      return op.v1 ? op.v1(corpo) : { ok: true, dados: { estado: 'aplicada' } };
    } },
  });
  return { sync, chamadas, config };
}

module.exports = { abrir, ambiente, syncFalso, EMPRESA, PRODUTO, ROTA_DESLIGADA, SEM_IDENTIDADE };

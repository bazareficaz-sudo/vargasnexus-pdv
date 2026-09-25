const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

const { EMPRESA, PRODUTO } = require('./helpers/venda-sync');
const pag = require('../src/main/pagamentoVenda');

// FASE 4C.2 — CHECKPOINT 2.
//
// A pergunta deste checkpoint é uma só: os pagamentos sobrevivem?
// A SQLite, ao fechamento do PDV, à reabertura, à fila, ao retry e ao crash.
//
// NADA aqui fala com o servidor. O protocolo continua V1 — estrutura local
// nova não é protocolo novo ativado, e o teste de compatibilidade V1 no fim
// é o mais importante da suíte.

// Carregador local: preciso poder trocar o `uuid` para forçar colisão de PK
// no SEGUNDO pagamento. O helper compartilhado da 0.6D.3B não expõe isso, e
// eu não quero alterá-lo — ele é a base comprovada deste checkpoint.
let Database;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch {
  const { DatabaseSync } = require('node:sqlite');
  Database = class {
    constructor(file) { this.raw = new DatabaseSync(file); }
    pragma(sql) { return this.raw.prepare(`PRAGMA ${sql}`).all(); }
    prepare(sql) {
      const stmt = this.raw.prepare(sql);
      return Object.fromEntries(['run', 'get', 'all'].map(m => [m,
        (...a) => stmt[m](...a.map(x => x === undefined ? null : x))]));
    }
    exec(sql) { return this.raw.exec(sql); }
    close() { this.raw.close(); }
    transaction(fn) {
      return (...a) => {
        this.exec('SAVEPOINT t');
        try { const r = fn(...a); this.exec('RELEASE t'); return r; }
        catch (e) { this.exec('ROLLBACK TO t'); this.exec('RELEASE t'); throw e; }
      };
    }
  };
}

function carregar(file, mocks) {
  const filename = path.resolve(__dirname, '../src/main', file);
  const req = Module.createRequire(filename);
  const mod = { exports: {} };
  const exec = vm.runInThisContext(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename });
  exec(mod.exports, n => Object.hasOwn(mocks, n) ? mocks[n] : req(n), mod, filename, path.dirname(filename));
  return mod.exports;
}

function abrirCom(dir, mocks = {}) {
  const db = carregar('database.js', {
    electron: { app: { getPath: () => dir } }, 'better-sqlite3': Database, ...mocks,
  });
  db.initialize();
  return db;
}

function semear(db) {
  db.db().prepare('INSERT INTO produtos (id, remote_id, nome, nome_lower, preco_venda) VALUES (?,?,?,?,?)')
    .run(PRODUTO, PRODUTO, 'TESTE', 'teste', 10);
  db.db().prepare('INSERT INTO estoque (id, produto_id, quantidade) VALUES (?,?,1000)').run('est', PRODUTO);
}

function novoDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-4c2-')); }

function ambiente(t, mocks) {
  const dir = novoDir();
  const db = abrirCom(dir, mocks);
  t.after(() => { try { db.db().close(); } catch {} });
  semear(db);
  return { dir, db };
}

const item = (total, qtd = 1) => ({
  produto_id: PRODUTO, produto_nome: 'TESTE', quantidade: qtd,
  preco_unitario: total / qtd, desconto: 0, total,
});

const venda = (over = {}) => ({
  empresa_id: EMPRESA, operador_nome: 'Operador', subtotal: over.total ?? 100,
  desconto: 0, total: over.total ?? 100, itens: [item(over.total ?? 100)], ...over,
});

const pagamentosDe = (db, id) =>
  db.db().prepare('SELECT * FROM venda_pagamentos WHERE venda_id = ? ORDER BY sequencia').all(id);

// ───────────────────────── TESTES DE OURO ─────────────────────────

describe('20) testes de ouro locais', () => {
  test('1. R$150 = 50 dinheiro + 100 cartao -> 2 registros', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 150, forma_pagamento: 'misto', pagamentos: [
      { forma: 'dinheiro', valor: 50 }, { forma: 'credito', valor: 100 },
    ] }));
    const ps = pagamentosDe(db, v.id);
    assert.equal(ps.length, 2);
    assert.deepEqual(ps.map(p => [p.forma, p.valor]), [['dinheiro', 50], ['credito', 100]]);
    assert.equal(pag.somarCentavos(ps), 15000);
  });

  test('2. R$147 = dinheiro 47 (entregue 50, troco 3) + cartao 100', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 147, forma_pagamento: 'misto', pagamentos: [
      { forma: 'dinheiro', valor: 47, valor_entregue: 50 }, { forma: 'credito', valor: 100 },
    ] }));
    const ps = pagamentosDe(db, v.id);
    assert.equal(ps.length, 2);
    // Aplicado é 147; entregue/troco NAO entram na soma.
    assert.equal(pag.somarCentavos(ps), 14700);
    assert.equal(ps[0].valor_entregue, 50);
    assert.equal(ps[0].troco, 3);
    // Cartao nao inventa entregue nem troco.
    assert.equal(ps[1].valor_entregue, null);
    assert.equal(ps[1].troco, null);
  });

  test('3. cartao 50 + cartao 50 -> 2 UUIDs diferentes', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'misto', pagamentos: [
      { forma: 'credito', valor: 50 }, { forma: 'credito', valor: 50 },
    ] }));
    const ps = pagamentosDe(db, v.id);
    assert.equal(ps.length, 2);
    assert.notEqual(ps[0].id, ps[1].id);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const p of ps) assert.match(p.id, uuid);
  });

  test('4. carteira 100 -> 1 pagamento local, ZERO conta a receber', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'carteira' }));
    const ps = pagamentosDe(db, v.id);
    assert.equal(ps.length, 1);
    assert.equal(ps[0].forma, 'carteira');
    assert.equal(ps[0].valor, 100);
    // A integracao da carteira é do Checkpoint 3. Aqui é so dado da venda.
    assert.equal(db.db().prepare('SELECT count(*) n FROM contas_receber').get().n, 0);
  });

  test('5. misto legado sem decomposicao -> ZERO pagamentos normalizados', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'misto', valor_pago: 100 }));
    assert.equal(pagamentosDe(db, v.id).length, 0);
    // A venda continua existindo pelo fluxo legado, intacta.
    const linha = db.db().prepare('SELECT forma_pagamento, total FROM vendas WHERE id = ?').get(v.id);
    assert.equal(linha.forma_pagamento, 'misto');
    assert.equal(linha.total, 100);
  });

  test('5b. multiplo (nome do PDV Web) tambem nao vira pagamento', () => {
    assert.deepEqual(pag.comporDaVendaLocal({ forma_pagamento: 'multiplo', total: 100 }), []);
    assert.deepEqual(pag.comporDaVendaLocal({ forma_pagamento: 'misto', total: 100 }), []);
  });

  test('6. falha AO INSERIR O SEGUNDO pagamento -> rollback total', t => {
    // `uuid` trocado: a 2a e a 3a chamadas devolvem o MESMO id. A 1a é a
    // venda; a 2a e a 3a sao os dois pagamentos. O segundo INSERT viola a PK.
    let n = 0;
    const COLIDIDO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const real = require('uuid');
    const { db } = ambiente(t, { uuid: { v4: () => (++n === 2 || n === 3) ? COLIDIDO : real.v4() } });

    const antes = db.db().prepare('SELECT quantidade FROM estoque WHERE produto_id = ?').get(PRODUTO).quantidade;

    assert.throws(() => db.vendas.registrar(venda({ total: 100, forma_pagamento: 'misto', pagamentos: [
      { forma: 'dinheiro', valor: 40 }, { forma: 'credito', valor: 60 },
    ] })));

    const q = sql => db.db().prepare(sql).get().n;
    assert.equal(q('SELECT count(*) n FROM vendas'), 0, 'venda nao persiste');
    assert.equal(q('SELECT count(*) n FROM venda_itens'), 0, 'itens nao persistem');
    assert.equal(q('SELECT count(*) n FROM venda_pagamentos'), 0, 'pagamentos nao persistem');
    assert.equal(q("SELECT count(*) n FROM sync_queue WHERE entidade='venda'"), 0, 'fila nao criada');
    assert.equal(q('SELECT count(*) n FROM movimentacoes_estoque'), 0, 'sem movimentacao');
    assert.equal(db.db().prepare('SELECT quantidade FROM estoque WHERE produto_id = ?').get(PRODUTO).quantidade,
      antes, 'estoque nao baixa');
  });

  test('9. venda historica NAO ganha pagamento por backfill', t => {
    const { db, dir } = ambiente(t);
    // Venda gravada "antes" da 4C.2: direto na tabela, sem passar pelo adaptador.
    db.db().prepare(`INSERT INTO vendas (id, numero, empresa_id, status, subtotal, desconto, total,
      forma_pagamento, valor_pago, troco, created_at, sync_status)
      VALUES ('velha', 1, ?, 'concluida', 80, 0, 80, 'dinheiro', 80, 0, '2026-01-01T00:00:00Z', 'synced')`).run(EMPRESA);
    db.db().close();

    // Reabre: as migrations rodam de novo e nao podem inventar nada.
    const db2 = abrirCom(dir);
    t.after(() => { try { db2.db().close(); } catch {} });
    assert.equal(pagamentosDe(db2, 'velha').length, 0);
    assert.equal(db2.db().prepare('SELECT count(*) n FROM venda_pagamentos').get().n, 0);
  });

  test('10. migration repetida é segura e nao altera historico', t => {
    const { db, dir } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 60, forma_pagamento: 'pix' }));
    const antes = pagamentosDe(db, v.id);
    db.db().close();

    // Abre e fecha tres vezes: CREATE TABLE IF NOT EXISTS reaplicado.
    for (let i = 0; i < 3; i++) { const d = abrirCom(dir); d.db().close(); }

    const db2 = abrirCom(dir);
    t.after(() => { try { db2.db().close(); } catch {} });
    assert.deepEqual(pagamentosDe(db2, v.id), antes, 'nada mudou');
    assert.equal(db2.db().prepare('SELECT count(*) n FROM venda_pagamentos').get().n, 1);
  });
});

// ───────────────────── ADAPTADOR DA UI ATUAL ─────────────────────

describe('7) adaptador da forma unica', () => {
  for (const [forma, esperado] of [['dinheiro', 1], ['credito', 1], ['debito', 1],
    ['pix', 1], ['carteira', 1], ['credito_cliente', 1], ['misto', 0], ['multiplo', 0]]) {
    test(`${forma} -> ${esperado} pagamento(s)`, t => {
      const { db } = ambiente(t);
      const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: forma, valor_pago: 100 }));
      const ps = pagamentosDe(db, v.id);
      assert.equal(ps.length, esperado);
      if (esperado) { assert.equal(ps[0].forma, forma); assert.equal(ps[0].valor, 100); }
    });
  }

  test('dinheiro com troco real preserva entregue e troco', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 90, forma_pagamento: 'dinheiro', valor_pago: 100 }));
    const [p] = pagamentosDe(db, v.id);
    assert.equal(p.valor, 90);
    assert.equal(p.valor_entregue, 100);
    assert.equal(p.troco, 10);
  });

  test('cartao NAO ganha entregue/troco inventados', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 90, forma_pagamento: 'credito', valor_pago: 90 }));
    const [p] = pagamentosDe(db, v.id);
    assert.equal(p.valor_entregue, null);
    assert.equal(p.troco, null);
  });
});

// ─────────────────────── CRASH / RESTART ───────────────────────

describe('14) crash e restart', () => {
  test('A. fecha e reabre: mesmo UUID e mesmos valores', t => {
    const { db, dir } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'dinheiro', valor_pago: 100 }));
    const antes = pagamentosDe(db, v.id);
    db.db().close();

    const db2 = abrirCom(dir);
    t.after(() => { try { db2.db().close(); } catch {} });
    assert.deepEqual(pagamentosDe(db2, v.id), antes);
  });

  test('B. 2 pagamentos: continuam 2, mesmos ids, mesma sequencia', t => {
    const { db, dir } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 150, forma_pagamento: 'misto', pagamentos: [
      { forma: 'dinheiro', valor: 50 }, { forma: 'credito', valor: 100 },
    ] }));
    const antes = pagamentosDe(db, v.id);
    db.db().close();

    const db2 = abrirCom(dir);
    t.after(() => { try { db2.db().close(); } catch {} });
    const depois = pagamentosDe(db2, v.id);
    assert.equal(depois.length, 2);
    assert.deepEqual(depois.map(p => p.id), antes.map(p => p.id));
    assert.deepEqual(depois.map(p => p.sequencia), [1, 2]);
  });

  test('C. venda offline continua pendente com pagamentos associados', t => {
    const { db, dir } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'pix' }));
    db.db().close();

    const db2 = abrirCom(dir);
    t.after(() => { try { db2.db().close(); } catch {} });
    const linha = db2.db().prepare('SELECT sync_status, remote_id, sync_protocolo FROM vendas WHERE id = ?').get(v.id);
    assert.equal(linha.sync_status, 'pending');
    assert.equal(linha.remote_id, null);
    assert.equal(linha.sync_protocolo, null);
    assert.equal(pagamentosDe(db2, v.id).length, 1);
    assert.equal(db2.db().prepare("SELECT count(*) n FROM sync_queue WHERE entidade='venda' AND processado=0").get().n, 1);
  });

  test('D. retry local NAO cria pagamentos novos', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'dinheiro', valor_pago: 100 }));
    const antes = pagamentosDe(db, v.id);

    // Retry = reler a venda e reprocessar. Nada disso grava pagamento.
    for (let i = 0; i < 3; i++) db.vendas.getById(v.id);
    db.db().prepare("UPDATE vendas SET sync_protocolo='negociando_v1' WHERE id=?").run(v.id);
    db.vendas.getById(v.id);

    assert.deepEqual(pagamentosDe(db, v.id), antes);
  });
});

// ───────────────────────── EDIÇÃO ─────────────────────────

describe('12) edicao de venda', () => {
  test('A. local 100 dinheiro -> editar para 80 -> 1 pagamento de 80', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'dinheiro', valor_pago: 100 }));
    db.vendas.editar(v.id, [item(80)], { forma_pagamento: 'dinheiro', valor_pago: 80 });

    const ps = pagamentosDe(db, v.id);
    assert.equal(ps.length, 1);
    assert.equal(ps[0].forma, 'dinheiro');
    assert.equal(ps[0].valor, 80);
    assert.equal(pag.somarCentavos(ps), 8000);
  });

  test('B. composicao antiga NAO sobrevive a edicao', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 150, forma_pagamento: 'misto', pagamentos: [
      { forma: 'dinheiro', valor: 50 }, { forma: 'credito', valor: 100 },
    ] }));
    const antigos = pagamentosDe(db, v.id).map(p => p.id);

    db.vendas.editar(v.id, [item(120)], { forma_pagamento: 'misto', pagamentos: [
      { forma: 'dinheiro', valor: 20 }, { forma: 'credito', valor: 100 },
    ] });

    const ps = pagamentosDe(db, v.id);
    assert.equal(pag.somarCentavos(ps), 12000, 'soma acompanha o novo total');
    for (const id of antigos) assert.ok(!ps.some(p => p.id === id), 'id antigo nao sobrevive');
  });

  test('C. virou misto sem decomposicao -> zero pagamentos, nada inventado', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'dinheiro', valor_pago: 100 }));
    assert.equal(pagamentosDe(db, v.id).length, 1);

    db.vendas.editar(v.id, [item(120)], { forma_pagamento: 'misto' });

    assert.equal(pagamentosDe(db, v.id).length, 0, 'removidos, nao preservados como mentira');
  });

  test('D. falha na substituicao -> rollback da edicao inteira', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'dinheiro', valor_pago: 100 }));
    const antes = {
      venda: db.db().prepare('SELECT total, forma_pagamento FROM vendas WHERE id=?').get(v.id),
      pagamentos: pagamentosDe(db, v.id),
      estoque: db.db().prepare('SELECT quantidade FROM estoque WHERE produto_id=?').get(PRODUTO).quantidade,
      itens: db.db().prepare('SELECT count(*) n FROM venda_itens WHERE venda_id=?').get(v.id).n,
    };

    // Composicao que nao fecha com o novo total: a validacao derruba a tx.
    assert.throws(() => db.vendas.editar(v.id, [item(80)], {
      forma_pagamento: 'misto', pagamentos: [{ forma: 'dinheiro', valor: 10 }],
    }), /nao fecha com o total/);

    assert.deepEqual(db.db().prepare('SELECT total, forma_pagamento FROM vendas WHERE id=?').get(v.id), antes.venda);
    assert.deepEqual(pagamentosDe(db, v.id), antes.pagamentos);
    assert.equal(db.db().prepare('SELECT quantidade FROM estoque WHERE produto_id=?').get(PRODUTO).quantidade, antes.estoque);
    assert.equal(db.db().prepare('SELECT count(*) n FROM venda_itens WHERE venda_id=?').get(v.id).n, antes.itens);
  });

  test('E. venda APLICADA no servidor: edicao bloqueada, zero alteracao', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'dinheiro', valor_pago: 100 }));
    db.db().prepare("UPDATE vendas SET remote_id='remoto-1', sync_protocolo='v1' WHERE id=?").run(v.id);
    const antes = pagamentosDe(db, v.id);

    assert.throws(() => db.vendas.editar(v.id, [item(80)], { forma_pagamento: 'dinheiro', valor_pago: 80 }),
      e => e.codigo === 'venda_sincronizada_com_pagamentos');

    assert.deepEqual(pagamentosDe(db, v.id), antes);
    assert.equal(db.db().prepare('SELECT total FROM vendas WHERE id=?').get(v.id).total, 100);
  });

  test('F. estado AMBIGUO nao é presumido local — preserva e bloqueia', t => {
    const { db } = ambiente(t);

    // F1: vinculada ao legado, sem remote_id. Pode ter sido aplicada la.
    const a = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'dinheiro', valor_pago: 100 }));
    db.db().prepare("UPDATE vendas SET sync_protocolo='legado' WHERE id=?").run(a.id);
    const psA = pagamentosDe(db, a.id);
    assert.throws(() => db.vendas.editar(a.id, [item(80)], { forma_pagamento: 'dinheiro', valor_pago: 80 }),
      e => e.codigo === 'venda_sincronizada_com_pagamentos');
    assert.deepEqual(pagamentosDe(db, a.id), psA);

    // F2: resposta perdida — negociando_v1 sem remote_id. O portao da
    // 0.6D.3B ja barra antes, e os pagamentos continuam intactos.
    const b = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'dinheiro', valor_pago: 100 }));
    db.db().prepare("UPDATE vendas SET sync_protocolo='negociando_v1' WHERE id=?").run(b.id);
    const psB = pagamentosDe(db, b.id);
    assert.throws(() => db.vendas.editar(b.id, [item(80)], { forma_pagamento: 'dinheiro', valor_pago: 80 }),
      e => e.codigo === 'v1_em_voo');
    assert.deepEqual(pagamentosDe(db, b.id), psB);
  });

  test('venda historica SEM pagamentos edita como sempre editou', t => {
    const { db } = ambiente(t);
    // Sem composicao normalizada, o portao novo nao dispara — nenhuma regressao.
    const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'misto' }));
    assert.equal(pagamentosDe(db, v.id).length, 0);
    db.db().prepare("UPDATE vendas SET sync_protocolo='legado' WHERE id=?").run(v.id);
    db.vendas.editar(v.id, [item(80)], { forma_pagamento: 'misto' });
    assert.equal(db.db().prepare('SELECT total FROM vendas WHERE id=?').get(v.id).total, 80);
  });
});

// ─────────────────────── CANCELAMENTO ───────────────────────

describe('17) cancelamento é soft e preserva os pagamentos', () => {
  test('cancelar NAO apaga venda_pagamentos', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'dinheiro', valor_pago: 100 }));
    const antes = pagamentosDe(db, v.id);

    assert.equal(db.vendas.cancelar(v.id, 'teste'), true);

    assert.equal(db.db().prepare('SELECT status FROM vendas WHERE id=?').get(v.id).status, 'cancelada');
    assert.deepEqual(pagamentosDe(db, v.id), antes, 'historico local preservado');
  });
});

// ──────────────────── COMPATIBILIDADE V1 ────────────────────

describe('21) o protocolo continua V1', () => {
  test('o payload V1 nao ganha pagamentos e segue schema_version 1', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 150, forma_pagamento: 'misto', pagamentos: [
      { forma: 'dinheiro', valor: 50 }, { forma: 'credito', valor: 100 },
    ] }));
    const { montarPayloadVendaV1 } = require('../src/main/payloadVendaV1');
    const r = montarPayloadVendaV1(db.vendas.getById(v.id), { empresaId: EMPRESA, terminalId: 'PDV-001' });
    assert.equal(r.ok, true, r.erro);
    assert.equal(r.payload.schema_version, 1);
    assert.ok(!('pagamentos' in r.payload), 'pagamentos NAO vao para o servidor neste checkpoint');
  });

  test('a venda entra na fila como sempre', t => {
    const { db } = ambiente(t);
    const v = db.vendas.registrar(venda({ total: 100, forma_pagamento: 'dinheiro', valor_pago: 100 }));
    const fila = db.db().prepare("SELECT * FROM sync_queue WHERE entidade='venda'").all();
    assert.equal(fila.length, 1);
    assert.equal(fila[0].operacao, 'create');
    assert.deepEqual(JSON.parse(fila[0].payload), { venda_id: v.id });
  });

  test('SCHEMA_VERSION continua 1 no modulo', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/main/payloadVendaV1.js'), 'utf8');
    assert.match(src, /SCHEMA_VERSION\s*=\s*1\b/);
  });
});

// ──────────────── ZERO INTEGRAÇÃO: CAIXA E REDE ────────────────

describe('19) nenhuma integracao de Caixa, carteira remota ou rede', () => {
  const fonte = f => fs.readFileSync(path.resolve(__dirname, '../src/main', f), 'utf8')
    .replace(/\/\/[^\n]*/g, '');

  test('pagamentoVenda.js nao fala com banco, rede nem Caixa', () => {
    const s = fonte('pagamentoVenda.js');
    for (const proibido of [/require\(/, /caixa/i, /supabase/i, /fetch\(/, /contas_receber/i]) {
      assert.doesNotMatch(s, proibido);
    }
  });

  test('venda_pagamentos nao vira conta a receber local', t => {
    const { db } = ambiente(t);
    db.vendas.registrar(venda({ total: 100, forma_pagamento: 'carteira' }));
    assert.equal(db.db().prepare('SELECT count(*) n FROM contas_receber').get().n, 0);
  });

  test('nenhuma tabela de Caixa existe no SQLite local', t => {
    const { db } = ambiente(t);
    const n = db.db().prepare(
      "SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'caixa%'").get().n;
    assert.equal(n, 0);
  });
});

// ──────────────────────── FK E SCHEMA ────────────────────────

describe('4/5) FK e representacao monetaria', () => {
  test('foreign_keys esta ON e a FK recusa venda inexistente', t => {
    const { db } = ambiente(t);
    assert.equal(db.db().pragma('foreign_keys')[0].foreign_keys, 1);
    assert.throws(() => db.db().prepare(`INSERT INTO venda_pagamentos
      (id, venda_id, forma, valor, sequencia, created_at) VALUES ('p','nao-existe','pix',1,1,'x')`).run());
  });

  test('sem cascade: a tabela nao declara ON DELETE', () => {
    const s = fs.readFileSync(path.resolve(__dirname, '../src/main/database.js'), 'utf8');
    const bloco = s.slice(s.indexOf('CREATE TABLE IF NOT EXISTS venda_pagamentos'));
    assert.doesNotMatch(bloco.slice(0, bloco.indexOf(');')), /ON DELETE/i);
  });

  test('invariante monetaria em centavos: 47 + 100 fecha 147 exato', () => {
    assert.equal(pag.somarCentavos([{ valor: 47 }, { valor: 100 }]), 14700);
    // O caso que apareceu em producao no jsonb.
    assert.equal(pag.centavos(197.32000000000002), 19732);
    const r = pag.validarComposicao([{ forma: 'dinheiro', valor: 47.0 }, { forma: 'pix', valor: 100.32 }], 147.32);
    assert.equal(r.ok, true, r.erro);
  });

  test('a soma que nao fecha é recusada', () => {
    const r = pag.validarComposicao([{ forma: 'dinheiro', valor: 50 }], 100);
    assert.equal(r.ok, false);
    assert.match(r.erro, /nao fecha com o total/);
  });

  test('misto nao é aceito como forma de UMA parcela', () => {
    const r = pag.validarComposicao([{ forma: 'misto', valor: 100 }], 100);
    assert.equal(r.ok, false);
    assert.match(r.erro, /descreve a venda/);
  });
});

// ─────────────────── ESTRITAMENTE LOCAL ───────────────────

describe('6) definicao de estritamente local', () => {
  const casos = [
    [{ sync_protocolo: null, remote_id: null }, true, 'nunca enviada'],
    [{ sync_protocolo: 'negociando_v1', remote_id: null }, false, 'binding persistido antes do request'],
    [{ sync_protocolo: 'v1', remote_id: null }, false, 'em voo'],
    [{ sync_protocolo: 'legado', remote_id: null }, false, 'vinculada ao legado'],
    [{ sync_protocolo: null, remote_id: 'r' }, false, 'ja tem remote_id'],
    [{ sync_protocolo: 'desconhecido', remote_id: null }, false, 'estado desconhecido'],
  ];
  for (const [v, esperado, porque] of casos) {
    test(`${JSON.stringify(v)} -> ${esperado} (${porque})`, () => {
      assert.equal(pag.ehEstritamenteLocal(v), esperado);
    });
  }
});

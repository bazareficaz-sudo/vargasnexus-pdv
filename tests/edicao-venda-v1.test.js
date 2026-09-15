const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

// FASE 0.6D.3A — a relação entre CRIAR e EDITAR uma venda.
//
// A 0.6D.3 descobriu, durante a implementação, que `vendas.editar` faz
// DELETE + INSERT dos itens com uuid novo. No protocolo v1 isso importa: o
// `venda_itens.id` é a identidade que torna item e movimento de estoque
// idempotentes, e o fingerprint guardado em `pdv_venda_sync` descreve o
// payload da CRIAÇÃO.
//
// Estes testes fixam a semântica: o que a edição faz hoje, e o que ela NÃO
// pode fazer enquanto a criação v1 estiver em voo.
//
// Exercita `database.js` de verdade. Sob `npm test` (Node do sistema) pula
// sozinho por ABI; para rodar a prova:
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test tests/edicao-venda-v1.test.js

let motivoSkip = null;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  const abis = String(err.message).match(/NODE_MODULE_VERSION \d+/g);
  motivoSkip = `better-sqlite3 não carrega sob este Node (${abis ? abis.join(' vs ') : err.code})`;
}

function carregarDatabase(dir) {
  const originalLoad = Module._load;
  Module._load = function (pedido) {
    if (pedido === 'electron') return { app: { getPath: () => dir } };
    return originalLoad.apply(this, arguments);
  };
  try {
    const caminho = require.resolve('../src/main/database');
    delete require.cache[caminho];
    return require(caminho);
  } finally {
    Module._load = originalLoad;
  }
}

function ambiente() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-063a-'));
  const db = carregarDatabase(dir);
  db.initialize();
  const bruto = db.db();
  bruto.prepare(`INSERT INTO produtos (id, nome, nome_lower, preco_venda, ativo)
                 VALUES ('p1','PROD A','prod a', 10, 1)`).run();
  bruto.prepare(`INSERT INTO produtos (id, nome, nome_lower, preco_venda, ativo)
                 VALUES ('p2','PROD B','prod b', 5, 1)`).run();
  bruto.prepare(`INSERT INTO estoque (id, produto_id, quantidade) VALUES ('e1','p1',100)`).run();
  bruto.prepare(`INSERT INTO estoque (id, produto_id, quantidade) VALUES ('e2','p2',50)`).run();
  return { db, bruto };
}

const venda = (itens) => ({
  empresa_id: 'emp-1', subtotal: 20, desconto: 0, total: 20,
  forma_pagamento: 'dinheiro', valor_pago: 20, troco: 0, _numero_base: 100000,
  itens: itens || [{ produto_id: 'p1', produto_nome: 'PROD A', quantidade: 2,
                     preco_unitario: 10, desconto: 0, total: 20 }],
});

const itensDe = (bruto, id) =>
  bruto.prepare('SELECT id, produto_id, quantidade FROM venda_itens WHERE venda_id = ? ORDER BY produto_id').all(id);

const suite = motivoSkip
  ? (nome, fn) => describe(nome, { skip: motivoSkip }, fn)
  : (nome, fn) => describe(nome, fn);

suite('0.6D.3A — o que a edição faz com a identidade dos itens', () => {
  test('ETAPA 2 — editar REGENERA o id de TODO item, inclusive o que não mudou', () => {
    const { db, bruto } = ambiente();
    const r = db.vendas.registrar(venda());
    const antes = itensDe(bruto, r.id);
    assert.equal(antes.length, 1);

    // Edição que não altera o item: mesma quantidade, mesmo produto.
    db.vendas.editar(r.id, [{ produto_id: 'p1', produto_nome: 'PROD A', quantidade: 2,
                              preco_unitario: 10, desconto: 0, total: 20 }],
                     { desconto: 0, forma_pagamento: 'dinheiro', valor_pago: 20, troco: 0 });

    const depois = itensDe(bruto, r.id);
    assert.equal(depois.length, 1);
    assert.notEqual(depois[0].id, antes[0].id,
      'o id muda mesmo quando o item é idêntico — é DELETE + INSERT, não UPDATE');
  });

  test('E5/E6/E7 — item mantido, acrescentado e removido: todos ganham id novo', () => {
    const { db, bruto } = ambiente();
    const r = db.vendas.registrar(venda([
      { produto_id: 'p1', produto_nome: 'PROD A', quantidade: 1, preco_unitario: 10, desconto: 0, total: 10 },
      { produto_id: 'p2', produto_nome: 'PROD B', quantidade: 1, preco_unitario: 5, desconto: 0, total: 5 },
    ]));
    const antes = itensDe(bruto, r.id);
    const idP1Antes = antes.find(i => i.produto_id === 'p1').id;

    // p1 continua (quantidade nova), p2 sai, p3 não existe: só p1 fica.
    db.vendas.editar(r.id, [{ produto_id: 'p1', produto_nome: 'PROD A', quantidade: 3,
                              preco_unitario: 10, desconto: 0, total: 30 }],
                     { desconto: 0, forma_pagamento: 'dinheiro', valor_pago: 30, troco: 0 });

    const depois = itensDe(bruto, r.id);
    assert.equal(depois.length, 1);
    assert.notEqual(depois[0].id, idP1Antes, 'o item SOBREVIVENTE também troca de id');
  });

  test('a edição ajusta o estoque local (estorna o antigo, baixa o novo)', () => {
    const { db, bruto } = ambiente();
    const r = db.vendas.registrar(venda()); // -2 → 98
    assert.equal(bruto.prepare("SELECT quantidade q FROM estoque WHERE produto_id='p1'").get().q, 98);

    db.vendas.editar(r.id, [{ produto_id: 'p1', produto_nome: 'PROD A', quantidade: 5,
                              preco_unitario: 10, desconto: 0, total: 50 }],
                     { desconto: 0, forma_pagamento: 'dinheiro', valor_pago: 50, troco: 0 });

    // +2 (estorno) −5 (novo) = 95
    assert.equal(bruto.prepare("SELECT quantidade q FROM estoque WHERE produto_id='p1'").get().q, 95);
  });

  test('a edição NÃO re-enfileira a venda e NÃO mexe no protocolo', () => {
    const { db, bruto } = ambiente();
    const r = db.vendas.registrar(venda());
    bruto.prepare("UPDATE vendas SET sync_protocolo='v1', remote_id=? WHERE id=?").run(r.id, r.id);
    const filaAntes = bruto.prepare("SELECT COUNT(*) c FROM sync_queue WHERE entidade='venda'").get().c;

    db.vendas.editar(r.id, [{ produto_id: 'p1', produto_nome: 'PROD A', quantidade: 1,
                              preco_unitario: 10, desconto: 0, total: 10 }],
                     { desconto: 0, forma_pagamento: 'dinheiro', valor_pago: 10, troco: 0 });

    const v = bruto.prepare('SELECT sync_protocolo, remote_id, sync_status FROM vendas WHERE id=?').get(r.id);
    assert.equal(bruto.prepare("SELECT COUNT(*) c FROM sync_queue WHERE entidade='venda'").get().c, filaAntes,
      'editar não cria item de fila — a venda editada não volta pela criação v1');
    assert.equal(v.sync_protocolo, 'v1');
    assert.equal(v.remote_id, r.id, 'remote_id preservado: ela não volta a ser "pendente"');
  });
});

suite('0.6D.3A — O GATE: venda v1 em voo não pode ser editada', () => {
  test('E3 — v1 pending (remote_id nulo) RECUSA edição', () => {
    const { db, bruto } = ambiente();
    const r = db.vendas.registrar(venda());
    // Estado exato do caso perigoso: escolheu v1, chamou o servidor, e não
    // sabe o que aconteceu lá.
    bruto.prepare("UPDATE vendas SET sync_protocolo='v1' WHERE id=?").run(r.id);

    assert.throws(
      () => db.vendas.editar(r.id, [{ produto_id: 'p1', produto_nome: 'PROD A', quantidade: 9,
                                      preco_unitario: 10, desconto: 0, total: 90 }],
                             { desconto: 0, forma_pagamento: 'dinheiro', valor_pago: 90, troco: 0 }),
      (e) => e.codigo === 'v1_em_voo',
    );

    // E o bloqueio não pode ter deixado efeito nenhum pelo caminho.
    assert.equal(itensDe(bruto, r.id)[0].quantidade, 2, 'itens intactos');
    assert.equal(bruto.prepare("SELECT quantidade q FROM estoque WHERE produto_id='p1'").get().q, 98,
      'estoque intacto');
  });

  test('E2 — v1 JÁ CONFIRMADA (remote_id preenchido) permite edição', () => {
    // O bloqueio é até a reconciliação, não para sempre. Confirmada, a venda
    // volta a ser editável pelo caminho de edição.
    const { db, bruto } = ambiente();
    const r = db.vendas.registrar(venda());
    bruto.prepare("UPDATE vendas SET sync_protocolo='v1', remote_id=? WHERE id=?").run(r.id, r.id);

    db.vendas.editar(r.id, [{ produto_id: 'p1', produto_nome: 'PROD A', quantidade: 1,
                              preco_unitario: 10, desconto: 0, total: 10 }],
                     { desconto: 0, forma_pagamento: 'dinheiro', valor_pago: 10, troco: 0 });

    assert.equal(itensDe(bruto, r.id)[0].quantidade, 1);
  });

  test('E1 — venda que ainda NÃO escolheu protocolo é editável', () => {
    const { db, bruto } = ambiente();
    const r = db.vendas.registrar(venda()); // sync_protocolo nulo
    db.vendas.editar(r.id, [{ produto_id: 'p1', produto_nome: 'PROD A', quantidade: 4,
                              preco_unitario: 10, desconto: 0, total: 40 }],
                     { desconto: 0, forma_pagamento: 'dinheiro', valor_pago: 40, troco: 0 });
    assert.equal(itensDe(bruto, r.id)[0].quantidade, 4);
  });

  test('E8 — venda LEGADO pendente continua editável (nada muda para ela)', () => {
    const { db, bruto } = ambiente();
    const r = db.vendas.registrar(venda());
    bruto.prepare("UPDATE vendas SET sync_protocolo='legado' WHERE id=?").run(r.id);

    db.vendas.editar(r.id, [{ produto_id: 'p1', produto_nome: 'PROD A', quantidade: 7,
                              preco_unitario: 10, desconto: 0, total: 70 }],
                     { desconto: 0, forma_pagamento: 'dinheiro', valor_pago: 70, troco: 0 });

    assert.equal(itensDe(bruto, r.id)[0].quantidade, 7,
      'o gate é só do v1 em voo — o legado segue exatamente como sempre foi');
  });

  test('E4 — depois do bloqueio, o retry do payload ORIGINAL continua possível', () => {
    // É o ponto do gate: ao impedir a edição, o payload que o retry vai
    // remontar continua sendo o mesmo da primeira tentativa.
    const { db, bruto } = ambiente();
    const r = db.vendas.registrar(venda());
    const idItemOriginal = itensDe(bruto, r.id)[0].id;
    bruto.prepare("UPDATE vendas SET sync_protocolo='v1' WHERE id=?").run(r.id);

    try {
      db.vendas.editar(r.id, [{ produto_id: 'p1', produto_nome: 'PROD A', quantidade: 9,
                                preco_unitario: 10, desconto: 0, total: 90 }],
                       { desconto: 0, forma_pagamento: 'dinheiro', valor_pago: 90, troco: 0 });
    } catch { /* esperado */ }

    assert.equal(itensDe(bruto, r.id)[0].id, idItemOriginal,
      'o id do item sobreviveu — o retry remonta o MESMO payload e o servidor reconhece');
  });
});

if (motivoSkip) {
  test(`prova de edição pulada — ${motivoSkip}`, () => { assert.ok(true); });
}

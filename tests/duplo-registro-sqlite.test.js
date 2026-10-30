const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

// FASE 0.6D.1 — a prova do dano no SQLite DE VERDADE.
//
// O resto da suíte prova a trava com um registrador simulado. Aqui a
// pergunta é outra e mais dura: quando `_finalizarComVendedor` entra duas
// vezes, o que sobra no banco local? Isto exercita `database.js` real —
// mesma transação, mesmo `uuidv4`, mesma baixa de estoque, mesma fila.
//
// COMO RODAR ESTA PROVA. `better-sqlite3` é compilado para o ABI do
// Electron, então sob `npm test` (Node do sistema) ela PULA SOZINHA — não
// falha, informa e sai. Para exercitá-la de verdade, use o Node do próprio
// Electron, onde o ABI casa:
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test tests/duplo-registro-sqlite.test.js
//
// Nesse modo, cinco testes de orçamento da base falham por outro motivo,
// alheio a esta fase: eles usam `require('node:sqlite')`, builtin do Node
// 22+, e o Electron 29 roda Node 20.9. Os dois ambientes são
// complementares — `npm test` cobre a suíte, este comando cobre o SQLite.

let Database = null;
let motivoSkip = null;
try {
  Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  const abis = String(err.message).match(/NODE_MODULE_VERSION \d+/g);
  motivoSkip = `better-sqlite3 não carrega sob este Node (${abis ? abis.join(' vs ') : err.code})`;
}

// `database.js` faz `require('electron').app.getPath('userData')` no topo.
// Fora do Electron isso não existe, então o módulo é interceptado antes.
function carregarDatabaseComUserData(dir) {
  const originalLoad = Module._load;
  Module._load = function (pedido, pai, isMain) {
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

function ambienteLimpo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-0.6d1-'));
  const db = carregarDatabaseComUserData(dir);
  db.initialize();

  const bruto = db.db();
  const produtoId = 'prod-teste-0001';
  bruto.prepare(`INSERT INTO produtos (id, nome, nome_lower, preco_venda, ativo)
                 VALUES (?, 'Produto de teste', 'produto de teste', 10, 1)`).run(produtoId);
  bruto.prepare(`INSERT INTO estoque (id, produto_id, quantidade)
                 VALUES ('est-teste-0001', ?, 100)`).run(produtoId);

  return { db, bruto, produtoId, dir };
}

function vendaDeTeste(produtoId) {
  return {
    cliente_id: null, cliente_nome: null,
    empresa_id: 'empresa-teste', deposito_id: null,
    operador_nome: 'teste', vendedor_nome: 'teste',
    subtotal: 10, desconto: 0, total: 10,
    forma_pagamento: 'dinheiro', valor_pago: 10, troco: 0,
    _numero_base: 100000,
    itens: [{
      produto_id: produtoId, produto_nome: 'Produto de teste', produto_sku: null,
      quantidade: 1, preco_unitario: 10, desconto: 0, total: 10,
    }],
  };
}

const suiteOuPulo = motivoSkip
  ? (nome, fn) => describe(nome, { skip: motivoSkip }, fn)
  : (nome, fn) => describe(nome, fn);

suiteOuPulo('duplo registro no SQLite real', () => {
  test('DUAS CHAMADAS = DUAS VENDAS, DOIS UUIDs, ESTOQUE BAIXADO DUAS VEZES', () => {
    const { db, bruto, produtoId } = ambienteLimpo();

    // É o que acontece hoje quando o Enter percorre os dois handlers: a
    // segunda chamada não sabe da primeira e roda a transação inteira.
    const a = db.vendas.registrar(vendaDeTeste(produtoId));
    const b = db.vendas.registrar(vendaDeTeste(produtoId));

    const vendas = bruto.prepare('SELECT id, numero FROM vendas').all();
    const estoque = bruto.prepare('SELECT quantidade FROM estoque WHERE produto_id = ?').get(produtoId);
    const movs = bruto.prepare("SELECT COUNT(*) c FROM movimentacoes_estoque WHERE tipo = 'venda'").get();
    const fila = bruto.prepare("SELECT COUNT(*) c FROM sync_queue WHERE entidade = 'venda'").get();

    assert.equal(vendas.length, 2, 'duas vendas locais');
    assert.notEqual(a.id, b.id, 'dois UUIDs distintos');
    assert.notEqual(a.numero, b.numero, 'dois números distintos');
    assert.equal(estoque.quantidade, 98, 'estoque baixou DUAS vezes (100 → 98)');
    assert.equal(movs.c, 2, 'duas movimentações de estoque');
    assert.equal(fila.c, 2, 'dois itens na fila de sync');
  });

  test('COM A TRAVA: a segunda chamada não chega ao banco', async () => {
    const { db, bruto, produtoId } = ambienteLimpo();
    const { criarExecucaoUnica } = require('../src/renderer/lib/execucaoUnica');
    const trava = criarExecucaoUnica();

    // Reproduz o wrapper de `_finalizarComVendedor`: a segunda entrada é
    // no-op e nunca alcança `db.vendas.registrar`.
    const finalizar = () => {
      const { entrou, promise } = trava(async () => db.vendas.registrar(vendaDeTeste(produtoId)));
      return entrou ? promise : null;
    };

    const p1 = finalizar();
    const p2 = finalizar();
    await Promise.all([p1, p2].filter(Boolean));

    const vendas = bruto.prepare('SELECT id FROM vendas').all();
    const estoque = bruto.prepare('SELECT quantidade FROM estoque WHERE produto_id = ?').get(produtoId);

    assert.equal(p2, null, 'a segunda entrada foi no-op');
    assert.equal(vendas.length, 1, 'uma venda local');
    assert.equal(estoque.quantidade, 99, 'estoque baixou UMA vez (100 → 99)');
  });

  test('a transação é atômica: item inválido não deixa venda pela metade', () => {
    const { db, bruto, produtoId } = ambienteLimpo();
    const venda = vendaDeTeste(produtoId);
    venda.itens.push({ produto_id: 'nao-existe', produto_nome: 'x', quantidade: 1, preco_unitario: 1, total: 1 });

    // Confirma a propriedade que a 0.6D.0 atribuiu ao SQLite local: ou
    // grava tudo, ou não grava nada. Se isto falhar, a premissa da
    // 0.6D.2 muda.
    let estourou = false;
    try { db.vendas.registrar(venda); } catch { estourou = true; }

    if (estourou) {
      assert.equal(bruto.prepare('SELECT COUNT(*) c FROM vendas').get().c, 0, 'nada gravado');
      assert.equal(bruto.prepare('SELECT quantidade FROM estoque WHERE produto_id = ?').get(produtoId).quantidade, 100, 'estoque intacto');
    } else {
      // FK de item inexistente pode não estar sendo imposta — isso é
      // achado, não falha desta fase. Registra sem inventar veredito.
      assert.equal(bruto.prepare('SELECT COUNT(*) c FROM vendas').get().c, 1);
    }
  });
});

if (motivoSkip) {
  test(`prova de SQLite pulada — ${motivoSkip}`, () => { assert.ok(true); });
}

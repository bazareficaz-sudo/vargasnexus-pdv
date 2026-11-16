const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// O CARRINHO DEPOIS DE GRAVAR O ORÇAMENTO.
//
// Relato do balcão, 16/11/2026: "a gente grava, os itens da tela não somem,
// a gente tem que excluir item a item para gerar uma venda".
//
// Ficava de propósito, e a intenção era boa: o cliente aceita na hora e o
// orçamento vira venda sem redigitar. Só que o que vem depois de um orçamento
// é o PRÓXIMO cliente — quem pediu orçamento saiu com o papel para pensar.
//
// Estes testes executam `salvarComoOrcamento` de verdade, recortada do fonte,
// com o carrinho e o IPC falsos.

const PDV = fs.readFileSync(path.resolve(__dirname, '..', 'src/renderer/pages/pdv.js'), 'utf8');

function extrair(fonte, assinatura) {
  const i = fonte.indexOf(assinatura);
  assert.notEqual(i, -1, `nao achei no fonte: ${assinatura}`);
  let nivel = 0, j = fonte.indexOf('{', i + assinatura.length - 1);
  for (; j < fonte.length; j++) {
    if (fonte[j] === '{') nivel++;
    else if (fonte[j] === '}') { nivel--; if (nivel === 0) break; }
  }
  return fonte.slice(i, j + 1);
}

function montar({ registrar } = {}) {
  const estado = {
    cart: [
      { produto_id: 'p1', produto_nome: 'CIMENTO', quantidade: 1, preco_unitario: 25.9, total: 25.9 },
      { produto_id: 'p2', produto_nome: 'AREIA', quantidade: 2, preco_unitario: 3, total: 6 },
    ],
    limpou: false,
    toasts: [],
    enviado: null,
  };
  const ctx = {
    get cart() { return estado.cart; },
    set cart(v) { estado.cart = v; },
    getSubtotal: () => 31.9,
    getDesconto: () => 0,
    selectedClient: { id: 'c1', nome: 'FULANO', telefone: '21999990000' },
    vendedorAtual: { nome: 'Silvano' },
    payMethod: 'dinheiro',
    pedidoObservacao: null,
    clearCart: () => { estado.limpou = true; estado.cart = []; },
    Toast: { show: (m) => estado.toasts.push(m) },
    window: {
      pdv: {
        config: { get: async () => ({ nome: 'Silvano' }) },
        orcamentos: {
          registrar: registrar || (async (o) => { estado.enviado = o; return { numero: 148 }; }),
        },
      },
    },
    module: {},
  };
  vm.createContext(ctx);
  vm.runInContext(`${extrair(PDV, 'async function salvarComoOrcamento()')}
    module.fn = salvarComoOrcamento;`, ctx);
  return { fn: ctx.module.fn, estado };
}

describe('gravar o orçamento no balcão', () => {
  test('o carrinho sai da tela', async () => {
    const { fn, estado } = montar();
    await fn();
    assert.equal(estado.limpou, true);
    assert.equal(estado.cart.length, 0);
  });

  test('o número do orçamento aparece, e a mensagem diz o que fazer para virar venda', async () => {
    const { fn, estado } = montar();
    await fn();
    const msg = estado.toasts.join(' | ');
    assert.match(msg, /#148/);
    assert.match(msg, /Converter em venda/i);
    assert.doesNotMatch(msg, /mantido/i, 'a mensagem antiga prometia o contrário do que agora acontece');
  });

  test('os itens sobem ANTES de o carrinho ser limpo', async () => {
    const { fn, estado } = montar();
    await fn();
    assert.equal(estado.enviado.itens.length, 2);
    assert.deepEqual(estado.enviado.itens.map(i => i.produto_nome), ['CIMENTO', 'AREIA']);
    assert.equal(estado.enviado.total, 31.9);
    assert.equal(estado.enviado.cliente_nome, 'FULANO');
  });

  // Limpar depois de uma falha apagaria o trabalho do vendedor sem ter
  // gravado nada — o pior dos dois mundos.
  test('se o servidor recusa, o carrinho FICA', async () => {
    const { fn, estado } = montar({ registrar: async () => { throw new Error('sem rede'); } });
    await fn();
    assert.equal(estado.limpou, false);
    assert.equal(estado.cart.length, 2);
    assert.match(estado.toasts.join(' | '), /sem rede/);
  });

  test('carrinho vazio nem tenta gravar', async () => {
    const { fn, estado } = montar();
    estado.cart = [];
    await fn();
    assert.equal(estado.enviado, null);
    assert.match(estado.toasts.join(' | '), /vazio/i);
  });
});

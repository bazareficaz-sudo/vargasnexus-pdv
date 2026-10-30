const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// F8 — LIMPAR A TELA.
//
// Relato do balcao: "o F8 parou de funcionar". O handler da tecla esta
// identico ao da 1.10.6, byte a byte, e nada no caminho engole o evento. O
// que fazia a tecla parecer morta era a condicao de saida de `clearCart`:
//
//     if (cart.length === 0 && !modoEdicao) return;
//
// So que `clearCart` nao esvazia so o carrinho — tira cliente, vendedor,
// desconto, observacao e dados de entrega junto. Com o carrinho vazio e um
// cliente selecionado, ou um desconto digitado, nao havia o que limpar
// SEGUNDO O CODIGO, mas havia segundo o operador. A tecla nao respondia e
// nao dizia por que.
//
// Com o carrinho realmente vazio e nada selecionado, F8 continua nao fazendo
// nada — e isso esta certo: nao ha o que limpar.

const UI = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/pages/pdv.js'), 'utf8');
// Comentarios fora: ancorar em comentario ja produziu assercao vazia neste
// projeto mais de uma vez.
const CODIGO = UI.replace(/\/\/[^\n]*/g, '');

describe('a tecla chega ao destino', () => {
  test('F8 continua ligada ao confirmador', () => {
    assert.match(CODIGO, /if \(e\.key === 'F8'\) \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*if \(!modalAberto\) _confirmarLimparCarrinho\(\);/);
  });

  test('o botao da barra chama o mesmo caminho', () => {
    // Tecla e botao divergirem seria o pior dos mundos: um funciona, o outro
    // nao, e ninguem descobre qual é o certo.
    assert.match(UI, /onclick="PDV\._confirmarLimparCarrinho\(\)"/);
  });

  test('a busca nao interrompe a propagacao', () => {
    // `onSearchKey` roda antes, no input. Se ele chamasse stopPropagation, o
    // handler global nunca veria o F8.
    const fn = CODIGO.slice(CODIGO.indexOf('function onSearchKey'),
                            CODIGO.indexOf('_abrirModalFaltaPDV({ nome: document'));
    assert.ok(fn.length > 600, `fn=${fn.length}`);
    assert.doesNotMatch(fn, /stopPropagation/);
  });

  test('confirma antes de apagar, quando ha itens', () => {
    const fn = CODIGO.slice(CODIGO.indexOf('async function _confirmarLimparCarrinho'),
                            CODIGO.indexOf('function clearCart'));
    assert.ok(fn.length > 200, `fn=${fn.length}`);
    assert.match(fn, /if \(cart\.length > 0\)/);
    assert.match(fn, /window\.pdv\.dialog\.confirm/);
    assert.match(fn, /if \(!ok\) return;/);
  });
});

describe('o que conta como "ha algo a limpar"', () => {
  const guarda = CODIGO.slice(CODIGO.indexOf('function clearCart'),
                              CODIGO.indexOf('if (!temAlgoALimpar) return;'));

  test('o recorte da guarda nao é vazio', () => {
    assert.ok(guarda.length > 200, `guarda=${guarda.length}`);
  });

  test('tudo que clearCart apaga entra na conta', () => {
    // A regra: se `clearCart` zera, a presenca daquilo tem de habilitar o F8.
    // Senao a tecla fica muda com a tela suja.
    for (const estado of [/cart\.length > 0/, /modoEdicao/, /selectedClient/,
                          /vendedorAtual/, /dadosEntrega/, /pedidoObservacao/,
                          /descontoDigitado/]) {
      assert.match(guarda, estado);
    }
  });

  test('o desconto é lido do campo, nao de uma copia', () => {
    assert.match(guarda, /document\.getElementById\('pdv-desconto'\)\?\.value \|\| 0\) !== 0/);
  });

  test('a condicao antiga, que olhava so o carrinho, nao existe mais', () => {
    assert.doesNotMatch(CODIGO, /if \(cart\.length === 0 && !modoEdicao\) return;/);
  });

  test('e clearCart continua zerando tudo o que promete', () => {
    const corpo = CODIGO.slice(CODIGO.indexOf('if (!temAlgoALimpar) return;'),
                               CODIGO.indexOf("window.pdv.telaCliente?.idle();"));
    assert.ok(corpo.length > 400, `corpo=${corpo.length}`);
    for (const limpeza of [/cart = \[\];/, /selectedClient = null;/, /vendedorAtual = null;/,
                           /dadosEntrega = null;/, /modoEdicao = null;/,
                           /pedidoObservacao = '';/, /_dispensadas = new Set\(\);/]) {
      assert.match(corpo, limpeza);
    }
  });
});

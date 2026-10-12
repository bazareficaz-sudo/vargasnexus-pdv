const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// F12 — ANOTAR FALTA SEM PERDER A BUSCA.
//
// Relato do balcao: o F12 abre o modal de falta e a lista de resultados
// fecha atras dele. Quem estava percorrendo dez adaptadores parecidos perde
// a busca inteira e precisa digitar de novo a cada item anotado.
//
// A lista fechava por uma linha explicita no inicio de `_abrirModalFaltaPDV`.
// Ela nao protegia de nada: o modal tem `z-index: 1000` e a lista `50`, entao
// ele ja aparecia por cima de qualquer jeito.
//
// Tirar a linha, so por si, criaria um problema pior — lista visivel e MORTA,
// porque as setas so andam com o foco no campo de busca. Por isso os dois
// caminhos de saida (Cancelar, registrar) e o Esc devolvem o teclado.

const UI = fs.readFileSync(
  path.resolve(__dirname, '../src/renderer/pages/pdv.js'), 'utf8');
// Comentarios fora: ancorar em comentario ja produziu assercao vazia neste
// projeto mais de uma vez.
const CODIGO = UI.replace(/\/\/[^\n]*/g, '');

describe('o modal de falta nao fecha mais a lista', () => {
  const fn = CODIGO.slice(CODIGO.indexOf('function _abrirModalFaltaPDV'),
                          CODIGO.indexOf('function _voltarParaLista'));

  test('o recorte da funcao nao é vazio', () => {
    assert.ok(fn.length > 1500, `fn=${fn.length}`);
  });

  test('nao esconde os resultados ao abrir', () => {
    assert.doesNotMatch(fn, /getElementById\('pdv-results'\)\.style\.display = 'none'/);
  });

  test('o F12 continua chamando o modal a partir da linha destacada', () => {
    assert.match(CODIGO, /if \(e\.key === 'F12'\)/);
    assert.match(CODIGO, /const idx = searchHighlight >= 0 \? searchHighlight : 0;/);
    assert.match(CODIGO, /_abrirModalFaltaPDV\(\{ nome: p\.nome, sku: p\.sku \|\| '', id: p\.id \}\)/);
  });
});

describe('ao fechar, o teclado volta para a lista', () => {
  const fn = CODIGO.slice(CODIGO.indexOf('function _voltarParaLista'),
                          CODIGO.indexOf('async function _confirmarFaltaPDV'));

  test('o recorte dos auxiliares nao é vazio', () => {
    assert.ok(fn.length > 400, `fn=${fn.length}`);
  });

  test('devolve o foco ao campo de busca', () => {
    // Lista visivel com foco perdido seria pior que lista fechada: estaria la,
    // e as setas nao andariam.
    assert.match(fn, /getElementById\('pdv-search'\)\?\.focus\(\)/);
  });

  test('NAO seleciona o texto da busca', () => {
    // `select()` faria a proxima tecla apagar a busca inteira — e a lista que
    // se quer preservar sumiria junto.
    assert.doesNotMatch(fn, /select\(\)/);
  });

  test('restaura o item destacado e o rola para a vista', () => {
    assert.match(fn, /searchHighlight/);
    assert.match(fn, /classList\.toggle\('highlighted', i === searchHighlight\)/);
    assert.match(fn, /scrollIntoView\(\{ block: 'nearest' \}\)/);
  });

  test('os TRES caminhos de saida passam por ele', () => {
    // Cancelar, registrar e Esc. Se so um devolvesse o foco, a diferenca entre
    // eles viraria um mistério para quem usa.
    assert.match(CODIGO, /onclick="PDV\._fecharFaltaPDV\(\)">Cancelar<\/button>/);
    assert.match(CODIGO, /const tipo = _faltaTipo;\s*\n\s*Modal\.close\(\);\s*\n\s*_voltarParaLista\(\);/);
    assert.match(CODIGO, /if \(e\.key === 'Escape' && modalAberto && document\.getElementById\('fpdv-qty'\)\)/);
  });

  test('o Esc do comprovante continua existindo, depois do da falta', () => {
    // Ordem importa: o teste de falta é mais especifico e precisa vir antes.
    const posFalta = CODIGO.indexOf("modalAberto && document.getElementById('fpdv-qty')");
    const posComprovante = CODIGO.indexOf("if (e.key === 'Escape' && modalAberto) {");
    assert.ok(posFalta > 0 && posComprovante > posFalta,
      `falta=${posFalta} comprovante=${posComprovante}`);
  });

  test('_fecharFaltaPDV é exportado — o HTML chama por PDV.', () => {
    assert.match(CODIGO, /_fecharFaltaPDV,/);
  });
});

describe('o que continua fechando a lista, e deve', () => {
  test('escolher um produto fecha', () => {
    // Escolhido o item, a lista cumpriu o papel. Aqui fechar é o certo.
    for (const fname of ['function selecionarProduto', 'async function escolherDaLista']) {
      const i = CODIGO.indexOf(fname);
      assert.ok(i > 0, `nao achei ${fname}`);
      const corpo = CODIGO.slice(i, i + 900);
      assert.match(corpo, /getElementById\('pdv-results'\)\.style\.display = 'none'/);
    }
  });

  test('Esc na busca fecha', () => {
    const fn = CODIGO.slice(CODIGO.indexOf('function onSearchKey'),
                            CODIGO.indexOf('function _abrirModalFaltaPDV'));
    assert.ok(fn.length > 600, `fn=${fn.length}`);
    assert.match(fn, /e\.key === 'Escape'[\s\S]{0,160}pdv-results'\)\.style\.display = 'none'/);
  });
});

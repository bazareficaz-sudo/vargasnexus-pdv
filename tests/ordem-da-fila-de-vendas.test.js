const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// DUAS SINCRONIZACOES PARA SUBIR UMA VENDA.
//
// `recuperarVendasPendentes` devolve a fila as vendas que sairam dela sem
// subir: a que esperou por rota desligada, a que pegou a internet fora no
// momento errado. Ela rodava DEPOIS de `processarFilaSync`, entao a venda
// recuperada so era enviada no ciclo seguinte.
//
// Com o automatico a cada 5 minutos, isso virava dez minutos de espera — e
// ninguem notava, porque na segunda rodada funcionava.
//
// MEDIDO EM 16/10/2026, Balcao 02: a flag `orcamentos` foi ligada as 15h, o
// operador sincronizou, e a venda continuou parada. `pdv_operacoes` mostrava
// a ultima tentativa de conversao as 12:34 — antes da correcao. A
// sincronizacao tinha apenas reenfileirado.

const SYNC = fs.readFileSync(
  path.resolve(__dirname, '../src/main/sync.js'), 'utf8');
// Comentarios fora: o texto que explica a ordem CITA as duas funcoes, e
// ancorar nele acharia a ordem certa dentro do proprio comentario.
const CODIGO = SYNC.replace(/\/\/[^\n]*/g, '');

describe('recuperar vem ANTES de processar', () => {
  const syncNow = CODIGO.slice(CODIGO.indexOf('async function syncNow'),
                               CODIGO.indexOf('async function syncDownClientesMesclados'));

  test('o recorte do syncNow nao é vazio', () => {
    assert.ok(syncNow.length > 800, `syncNow=${syncNow.length}`);
  });

  test('as duas chamadas existem', () => {
    assert.match(syncNow, /await recuperarVendasPendentes\(\);/);
    assert.match(syncNow, /await processarFilaSync\(\);/);
  });

  test('e recuperar vem primeiro', () => {
    // É a correcao inteira. Invertido, a venda recuperada espera o proximo
    // ciclo — e com o automatico a cada 5 minutos, dez minutos parada.
    const recuperar = syncNow.indexOf('await recuperarVendasPendentes()');
    const processar = syncNow.indexOf('await processarFilaSync()');
    assert.ok(recuperar > 0 && processar > 0, 'as duas tem de estar no syncNow');
    assert.ok(recuperar < processar,
      `recuperar esta em ${recuperar} e processar em ${processar} — ordem invertida`);
  });

  test('produtos sobem antes da venda, como sempre', () => {
    // Venda com produto criado no balcao precisa do produto no servidor
    // antes, senao o item sobe sem produto vinculado.
    const produtos = syncNow.indexOf('await syncUpProdutos()');
    const processar = syncNow.indexOf('await processarFilaSync()');
    assert.ok(produtos > 0 && produtos < processar,
      'syncUpProdutos tem de vir antes de processar a fila');
  });

  test('clientes tambem', () => {
    const clientes = syncNow.indexOf('await recuperarClientesPendentes()');
    const processar = syncNow.indexOf('await processarFilaSync()');
    assert.ok(clientes > 0 && clientes < processar);
  });
});

describe('o que NAO mudou', () => {
  test('a perdedora de arbitragem continua fora da recuperacao', () => {
    // Ela tem `remote_id` nulo para sempre, de proposito: nao existe no
    // servidor e nao deve passar a existir. Recuperar antes de processar
    // tornaria o furo MAIS rapido, se o filtro nao estivesse la.
    const fn = CODIGO.slice(CODIGO.indexOf('async function recuperarVendasPendentes'),
                            CODIGO.indexOf('async function recuperarVendasPendentes') + 1200);
    assert.ok(fn.length > 400, `fn=${fn.length}`);
    assert.match(fn, /sync_status, ''\) != 'conflito_orcamento'/);
  });

  test('e a recuperacao nao duplica o que ja esta na fila', () => {
    // Sem isto, inverter a ordem criaria envio duplo no mesmo ciclo.
    const fn = CODIGO.slice(CODIGO.indexOf('async function recuperarVendasPendentes'),
                            CODIGO.indexOf('async function recuperarVendasPendentes') + 1200);
    assert.match(fn, /NOT EXISTS/);
    assert.match(fn, /sq\.processado = 0/);
  });

  test('cancelada nao volta para a fila', () => {
    const fn = CODIGO.slice(CODIGO.indexOf('async function recuperarVendasPendentes'),
                            CODIGO.indexOf('async function recuperarVendasPendentes') + 1200);
    assert.match(fn, /v\.status != 'cancelada'/);
  });
});

describe('syncFila continua como estava', () => {
  // A fila disparada logo apos a venda nao recupera orfaos, e nao passou a
  // recuperar: é o caminho mais quente do sistema, e mexer nele hoje seria
  // ampliar o escopo de uma correcao de ordem. Fica registrado.
  const syncFila = CODIGO.slice(CODIGO.indexOf('async function syncFila'),
                                CODIGO.indexOf('function startAutoSync'));

  test('o recorte nao é vazio', () => {
    assert.ok(syncFila.length > 300, `syncFila=${syncFila.length}`);
  });

  test('processa a fila, sem recuperar orfaos', () => {
    assert.match(syncFila, /await processarFilaSync\(\);/);
    assert.doesNotMatch(syncFila, /recuperarVendasPendentes/);
  });
});

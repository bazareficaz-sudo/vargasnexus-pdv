const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// OS CANOS DA NEGOCIACAO: sync, IPC e tela.
//
// A conta em si esta coberta em orcamento-negociacao.test.js e o papel em
// orcamento-cupom.test.js. Aqui trava-se a ligacao entre eles — que e onde
// uma funcionalidade certa deixa de aparecer na tela sem ninguem perceber.

const raiz = path.resolve(__dirname, '..');
const ler = (p) => fs.readFileSync(path.join(raiz, p), 'utf8');
// Comentarios fora: ancorar em comentario ja produziu assercao vazia aqui.
const semComentarios = (t) => t.replace(/\/\/[^\n]*/g, '');

describe('a politica desce pelo sync', () => {
  const SYNC = semComentarios(ler('src/main/sync.js'));
  const API = semComentarios(ler('src/main/api.js'));

  test('o recorte nao é vazio', () => {
    assert.ok(SYNC.length > 2000 && API.length > 2000);
  });

  test('vai pela rota autenticada, nao pelo anon', () => {
    // `saude_faixas` nao esta aberta ao `anon` — conferido em producao.
    assert.match(API, /chamarProtegida\('\/api\/pdv\/saude', null, \{ metodo: 'GET' \}\)/);
    assert.doesNotMatch(API, /from\('saude_faixas'\)/);
  });

  test('entra na sequencia do sync', () => {
    assert.match(SYNC, /await syncDownConfigCupom\(\);\s*\n\s*await syncDownPoliticaSaude\(\);/);
  });

  test('guarda a politica INTEIRA, sem recortar campos', () => {
    // Recortar aqui criaria uma terceira definicao de politica. Ja bastam as
    // duas que existiam — e a divergencia entre elas e o motivo deste sync.
    const fn = SYNC.slice(SYNC.indexOf('async function syncDownPoliticaSaude'),
                          SYNC.indexOf('async function syncDownConfigTermometro'));
    assert.ok(fn.length > 200, `fn=${fn.length}`);
    assert.match(fn, /store\.set\('saude_politica', \{ \.\.\.p/);
  });

  test('resposta vazia NAO apaga a politica que ja estava la', () => {
    // Politica velha e melhor que politica nenhuma: sem ela o terminal cai
    // nas faixas de fabrica, que nao sao as da loja.
    const fn = SYNC.slice(SYNC.indexOf('async function syncDownPoliticaSaude'),
                          SYNC.indexOf('async function syncDownConfigTermometro'));
    assert.match(fn, /if \(!p \|\| \(!p\.config && p\.faixas\.length === 0\)\) return;/);
  });

  test('falha de leitura devolve undefined, nao lista vazia', () => {
    const fn = API.slice(API.indexOf('async function buscarPoliticaSaude'),
                         API.indexOf('// ─── Compre Junto'));
    assert.ok(fn.length > 300, `fn=${fn.length}`);
    assert.match(fn, /if \(!r\.ok\) \{[\s\S]{0,300}return undefined;/);
  });
});

describe('o calculo mora no processo principal', () => {
  const MAIN = semComentarios(ler('src/main/main.js'));
  const PRELOAD = semComentarios(ler('src/main/preload.js'));
  const UI = semComentarios(ler('src/renderer/pages/orcamentos.js'));

  test('o IPC existe e usa a politica guardada', () => {
    assert.match(MAIN, /ipcMain\.handle\('orcamento:negociar'/);
    assert.match(MAIN, /politica: store\.get\('saude_politica'\) \|\| null/);
    assert.match(MAIN, /buscarProdutos: \(ids\) => db\.produtos\.porIds\(ids\)/);
  });

  test('a ponte do preload existe', () => {
    assert.match(PRELOAD, /calcular: \(dados\) => ipcRenderer\.invoke\('orcamento:negociar', dados\)/);
  });

  test('a TELA nao recalcula nada', () => {
    // Duas copias da regra divergem, e aí a tela passa a mentir sobre o que
    // vai sair impresso — e o papel e o que vai para a mao do cliente.
    assert.match(UI, /window\.pdv\.orcamento_negociacao\.calcular/);
    for (const regra of [/parcelasSugeridas/, /calcularVitrinePromo/, /taxa_credito/, /margem_min/]) {
      assert.doesNotMatch(UI, regra);
    }
  });
});

describe('a tela de negociacao', () => {
  const UI = semComentarios(ler('src/renderer/pages/orcamentos.js'));

  test('mostra a saude de CADA condicao', () => {
    // O ponto da tela: o vendedor ve o chao antes de prometer.
    const fn = UI.slice(UI.indexOf('async function _pintarNegociacao'),
                        UI.indexOf('function _aplicarDescontoNegociacao'));
    assert.ok(fn.length > 1500, `fn=${fn.length}`);
    assert.match(fn, /n\.saude\.parcelado/);
    assert.match(fn, /n\.saude\.avista/);
    assert.match(fn, /taxa \$\{fm\(n\.saude\.parcelado\?\.taxaPagPct\)\}%/);
  });

  test('mostra o aviso do desconto manual menor que a promocao', () => {
    const fn = UI.slice(UI.indexOf('async function _pintarNegociacao'),
                        UI.indexOf('function _aplicarDescontoNegociacao'));
    assert.match(fn, /n\.aviso \?/);
    assert.match(fn, /neg-alerta-perigo/);
  });

  test('avisa quando falta custo, em vez de mostrar margem inflada calada', () => {
    const fn = UI.slice(UI.indexOf('async function _pintarNegociacao'),
                        UI.indexOf('function _aplicarDescontoNegociacao'));
    assert.match(fn, /n\.semCusto \?/);
    assert.match(fn, /inflada/);
  });

  test('desconto vazio volta ao padrao, NAO grava 0%', () => {
    // 0% seria "sem desconto nenhum", que e outra coisa de "nao configurei".
    const fn = UI.slice(UI.indexOf('function _aplicarDescontoNegociacao'),
                        UI.indexOf('function _limparDescontoNegociacao'));
    assert.ok(fn.length > 200, `fn=${fn.length}`);
    assert.match(fn, /if \(!v \|\| v <= 0\) _descontoManual\.delete/);
  });

  test('o desconto manual NAO é gravado no documento', () => {
    // É rascunho de negociacao. Salvar sem o vendedor mandar mudaria o
    // orcamento pelas costas dele.
    const fn = UI.slice(UI.indexOf('const _descontoManual = new Map()'),
                        UI.indexOf('async function abrirNegociacao'));
    assert.ok(fn.length > 150, `fn=${fn.length}`);
    assert.doesNotMatch(fn, /orcamentos\.(salvar|atualizar)/);
  });
});

describe('a impressao leva as condicoes', () => {
  const UI = semComentarios(ler('src/renderer/pages/orcamentos.js'));

  test('o payload do print inclui a negociacao', () => {
    assert.match(UI, /window\.pdv\.print\.orcamento\(\{ \.\.\.orc, negociacao \}\)/);
  });

  test('falha no calculo nao impede de imprimir', () => {
    // O papel antigo ainda serve. Um orcamento sem condicoes e melhor que
    // nenhum orcamento na mao do cliente.
    const fn = UI.slice(UI.indexOf('async function _negociar(orc)'),
                        UI.indexOf('async function abrirNegociacao'));
    assert.ok(fn.length > 300, `fn=${fn.length}`);
    assert.match(fn, /catch[\s\S]{0,200}return null;/);
  });

  test('o botao de negociar existe no detalhe', () => {
    assert.match(UI, /Orcamentos\.abrirNegociacao\(/);
    assert.match(UI, /Negociar e imprimir/);
  });

  test('e o imprimir direto continua, para quem nao quer negociar', () => {
    assert.match(UI, /Imprimir direto/);
  });
});

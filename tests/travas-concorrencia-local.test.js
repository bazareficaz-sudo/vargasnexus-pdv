const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// FASE 0.6D.1 — onde as travas de concorrência local estão ligadas.
//
// O primitivo tem teste próprio (`execucaoUnica.test.js`). Este arquivo
// garante que ele continua PLUGADO nos três pontos que importam — é o tipo
// de coisa que um refactor desfaz sem que nenhum teste de lógica perceba.
//
// Técnica (asserção sobre o texto-fonte) já usada em
// `sistema-vargas/tests/pdv/ordem-triggers-vendas.test.ts`, que lê as
// migrations como texto para provar a ordem dos triggers.

const raiz = path.join(__dirname, '..');
const ler = (...p) => fs.readFileSync(path.join(raiz, ...p), 'utf8');

const SYNC = ler('src', 'main', 'sync.js');
const PDV = ler('src', 'renderer', 'pages', 'pdv.js');
const HTML = ler('src', 'renderer', 'index.html');

describe('a fila e o sync', () => {
  test('syncFila passa pela trava', () => {
    assert.match(SYNC, /async function syncFila\(win\) \{\s*const \{ promise \} = travaFila/);
  });

  test('processarFilaSync passa pela trava', () => {
    // É a seção crítica de verdade: `syncNow` e `syncFila` chamam as duas.
    // Sem isto, as duas liam a MESMA lista de `getPendentes()`.
    assert.match(SYNC, /async function processarFilaSync\(\) \{\s*const \{ promise \} = travaDrenagem/);
  });

  test('são travas separadas', () => {
    assert.match(SYNC, /const travaFila = criarExecucaoUnica\(\)/);
    assert.match(SYNC, /const travaDrenagem = criarExecucaoUnica\(\)/);
  });

  test('o export de processarFilaSync continua apontando para a porta travada', () => {
    // `_processarFilaSync` é exportado para teste. Se ele passasse a apontar
    // para a função interna, os testes exercitariam o caminho sem trava.
    assert.match(SYNC, /_processarFilaSync:\s*processarFilaSync/);
  });
});

describe('a finalização no renderer', () => {
  test('_finalizarComVendedor é o wrapper com trava', () => {
    assert.match(PDV, /const _travaFinalizacao = ExecucaoUnica\.criarExecucaoUnica\(\)/);
    assert.match(PDV, /async function _finalizarComVendedor\(\) \{\s*const \{ entrou, promise \} = _travaFinalizacao/);
  });

  test('o nome público não mudou — o HTML chama PDV._finalizarComVendedor', () => {
    // Três entradas dependem deste nome; renomear quebraria as três de uma vez.
    assert.match(PDV, /_abrirModalVendedor, _validarVendedor, _finalizarComVendedor, _vendedorAtualValido/);
  });

  test('AS TRÊS ENTRADAS CONTINUAM EXISTINDO — a trava é a única coisa entre elas e a escrita', () => {
    const chamadas = [...PDV.matchAll(/PDV\._finalizarComVendedor\(\)/g)];
    assert.equal(chamadas.length, 3,
      'se este número mudou, alguém somou ou tirou uma entrada — reavalie a trava');
  });
});

describe('carregamento do módulo no renderer', () => {
  test('execucaoUnica.js carrega antes do pdv.js', () => {
    const posTrava = HTML.indexOf('lib/execucaoUnica.js');
    const posPdv = HTML.indexOf('pages/pdv.js');
    assert.notEqual(posTrava, -1, 'o <script> da trava sumiu do index.html');
    assert.ok(posTrava < posPdv, 'sem isto, `ExecucaoUnica` fica indefinido na primeira venda');
  });

  test('todos os <script src> do index.html apontam para arquivos que existem', () => {
    const dirHtml = path.join(raiz, 'src', 'renderer');
    const srcs = [...HTML.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
    assert.ok(srcs.includes('lib/execucaoUnica.js'));
    for (const src of srcs) {
      assert.ok(fs.existsSync(path.resolve(dirHtml, src)), `<script src="${src}"> não existe`);
    }
  });
});

describe('o que esta fase NÃO tocou', () => {
  const API = ler('src', 'main', 'api.js');

  test('a identidade da venda continua viajando (0.6C.6A)', () => {
    assert.match(API, /id:\s*venda\.id/);
  });

  test('o reenvio continua reconhecido por id, não por heurística (0.6C.6A)', () => {
    assert.match(API, /\.eq\('id',\s*venda\.id\)/);
  });

  test('o portão de arbitragem continua no caminho da venda (0.6C.6A.1)', () => {
    assert.match(SYNC, /_arbitrarAntesDeSubir/);
    assert.ok(fs.existsSync(path.join(raiz, 'src', 'main', 'arbitragemVenda.js')));
  });

  test('o guardrail 23000 continua virando desfecho terminal (0.6C.6A.1)', () => {
    assert.match(API, /arbitragem_orcamento:/);
  });
});

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');

// COMPRE JUNTO E PRODUTOS SIMILARES NO PDV DESKTOP.
//
// Duas coisas que o PDV web ja fazia:
//
//   SIMILARES  — o gestor agrupa no cadastro os produtos que sao o mesmo item
//                de marcas diferentes. Escolher pela lista da busca abre o
//                modal com as marcas antes de lancar.
//   COMPRE JUNTO — o que os clientes costumam levar junto, calculado no
//                servidor sobre o historico da loja inteira.
//
// O que estes testes travam é a parte que da para errar sem ninguem perceber:
// a normalizacao do rotulo, o que entra e sai das consultas locais, e as tres
// respostas diferentes do servidor (falhou, vazio, tem).
//
// Os testes de banco exercitam `database.js` de verdade. Sob `npm test` (Node
// do sistema) pulam sozinhos por ABI; a prova roda com:
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --test tests/compre-junto-e-similares.test.js

// ─────────────────────────────────────────────────────────────────────────
// A NORMALIZACAO DO ROTULO — sem banco, sempre roda
// ─────────────────────────────────────────────────────────────────────────
describe('o rotulo do grupo tem forma canonica', () => {
  const { normalizarGrupoSimilar } = require('../src/main/similares');

  test('maiusculas e espacos simples', () => {
    // É o ponto inteiro: um espaco digitado a mais no cadastro separaria o
    // produto dos seus similares, e o modal deixaria de abrir sem erro nenhum.
    assert.equal(normalizarGrupoSimilar('disjuntor  mono 32a '), 'DISJUNTOR MONO 32A');
    assert.equal(normalizarGrupoSimilar('DISJUNTOR MONO 32A'), 'DISJUNTOR MONO 32A');
    assert.equal(normalizarGrupoSimilar(' cabo\t2,5mm '), 'CABO 2,5MM');
  });

  test('vazio, espacos, null e undefined viram null — nao string vazia', () => {
    // String vazia seria um GRUPO chamado "", e dois produtos sem grupo
    // virariam similares um do outro.
    for (const v of ['', '   ', '\n', null, undefined]) {
      assert.equal(normalizarGrupoSimilar(v), null, `falhou para ${JSON.stringify(v)}`);
    }
  });

  test('nao é destrutiva: acento e pontuacao permanecem', () => {
    assert.equal(normalizarGrupoSimilar('fusível 10a'), 'FUSÍVEL 10A');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// O BANCO LOCAL
// ─────────────────────────────────────────────────────────────────────────
let motivoSkip = null;
try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
} catch (err) {
  const abis = String(err.message).match(/NODE_MODULE_VERSION \d+/g);
  motivoSkip = `better-sqlite3 não carrega sob este Node (${abis ? abis.join(' vs ') : err.code})`;
}

// `{ skip: null }` ja conta como pular no node:test — a opcao so pode ser
// passada quando ha motivo. Mesmo contorno de edicao-venda-v1.test.js.
const suite = motivoSkip
  ? (nome, fn) => describe(nome, { skip: motivoSkip }, fn)
  : (nome, fn) => describe(nome, fn);

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-cj-'));
  const db = carregarDatabase(dir);
  db.initialize();
  return { db, bruto: db.db() };
}

// O produto como o servidor manda.
const remoto = (id, nome, extra = {}) => ({
  id, nome, sku: nome.replace(/\s+/g, '-').toUpperCase(), preco_venda: 10,
  ativo: true, disponivel_pdv: true, estoque: 5, ...extra,
});

suite('o catalogo local guarda o grupo', () => {
  test('a coluna e o indice existem depois do initialize', () => {
    const { bruto } = ambiente();
    const colunas = bruto.prepare('PRAGMA table_info(produtos)').all().map(c => c.name);
    assert.ok(colunas.includes('grupo_similar'), 'produtos.grupo_similar ausente');
    const indices = bruto.prepare('PRAGMA index_list(produtos)').all().map(i => i.name);
    assert.ok(indices.includes('idx_produtos_grupo_similar'), 'indice ausente');
  });

  test('venda_itens guarda a origem do item', () => {
    const { bruto } = ambiente();
    const colunas = bruto.prepare('PRAGMA table_info(venda_itens)').all().map(c => c.name);
    assert.ok(colunas.includes('origem_sugestao'), 'venda_itens.origem_sugestao ausente');
  });

  test('o grupo chega NORMALIZADO ao banco, venha como vier', () => {
    const { db, bruto } = ambiente();
    db.produtos.upsertBatch([
      remoto('r1', 'Disjuntor Mono 32A Steck', { grupo_similar: 'disjuntor  mono 32a ' }),
      remoto('r2', 'Disjuntor Mono 32A Weg',   { grupo_similar: 'DISJUNTOR MONO 32A' }),
      remoto('r3', 'Fita isolante',            { grupo_similar: '   ' }),
    ]);
    const linhas = bruto.prepare(
      'SELECT remote_id, grupo_similar FROM produtos ORDER BY remote_id').all();
    assert.equal(linhas[0].grupo_similar, 'DISJUNTOR MONO 32A');
    assert.equal(linhas[1].grupo_similar, 'DISJUNTOR MONO 32A');
    assert.equal(linhas[2].grupo_similar, null, 'so espacos tinha de virar null');
  });

  test('o grupo ACOMPANHA a atualizacao do produto', () => {
    // O gestor tira o produto do grupo no cadastro: o terminal precisa
    // esquecer, nao manter o rotulo antigo para sempre.
    const { db, bruto } = ambiente();
    db.produtos.upsertBatch([remoto('r1', 'Disjuntor', { grupo_similar: 'DISJ 32' })]);
    db.produtos.upsertBatch([remoto('r1', 'Disjuntor', { grupo_similar: null })]);
    const linha = bruto.prepare('SELECT grupo_similar FROM produtos WHERE remote_id = ?').get('r1');
    assert.equal(linha.grupo_similar, null);
  });
});

suite('a consulta de similares', () => {
  function comGrupo() {
    const env = ambiente();
    env.db.produtos.upsertBatch([
      remoto('r1', 'Disjuntor Steck', { grupo_similar: 'DISJ 32', marca: 'STECK', estoque: 2 }),
      remoto('r2', 'Disjuntor Weg',   { grupo_similar: 'DISJ 32', marca: 'WEG',   estoque: 9 }),
      remoto('r3', 'Disjuntor Siemens', { grupo_similar: 'DISJ 32', marca: 'SIEMENS', estoque: 0 }),
      remoto('r4', 'Disjuntor Inativo', { grupo_similar: 'DISJ 32', ativo: false, estoque: 50 }),
      remoto('r5', 'Disjuntor Fora do PDV', { grupo_similar: 'DISJ 32', disponivel_pdv: false, estoque: 50 }),
      remoto('r6', 'Fita isolante', { grupo_similar: 'FITA', estoque: 7 }),
    ]);
    return env;
  }

  test('do MAIOR estoque para o menor', () => {
    // O vendedor atende mais rapido oferecendo o que esta na prateleira.
    const { db } = comGrupo();
    const nomes = db.produtos.similares('DISJ 32').map(p => p.nome);
    assert.deepEqual(nomes, ['Disjuntor Weg', 'Disjuntor Steck', 'Disjuntor Siemens']);
  });

  test('sem estoque CONTINUA na lista, no fim', () => {
    // Pode haver encomenda, ou o cadastro estar atrasado. Sumir seria decidir
    // pelo cliente que aquilo nao existe.
    const { db } = comGrupo();
    assert.ok(db.produtos.similares('DISJ 32').some(p => p.nome === 'Disjuntor Siemens'));
  });

  test('inativo e fora do PDV ficam de fora', () => {
    // Mostrar no modal uma marca que a busca desta mesma tela nunca
    // devolveria seria oferecer o que este balcao nao vende.
    const { db } = comGrupo();
    const nomes = db.produtos.similares('DISJ 32').map(p => p.nome);
    assert.ok(!nomes.includes('Disjuntor Inativo'));
    assert.ok(!nomes.includes('Disjuntor Fora do PDV'));
  });

  test('aceita o rotulo em qualquer forma', () => {
    const { db } = comGrupo();
    assert.equal(db.produtos.similares(' disj  32 ').length, 3);
  });

  test('grupo vazio, nulo ou inexistente devolve lista vazia, nao tudo', () => {
    const { db } = comGrupo();
    for (const g of [null, '', '   ', 'NAO EXISTE']) {
      assert.deepEqual(db.produtos.similares(g), [], `falhou para ${JSON.stringify(g)}`);
    }
  });

  test('nao vaza produto de outro grupo', () => {
    const { db } = comGrupo();
    assert.ok(!db.produtos.similares('DISJ 32').some(p => p.nome === 'Fita isolante'));
  });
});

suite('o catalogo por ids remotos', () => {
  function catalogo() {
    const env = ambiente();
    env.db.produtos.upsertBatch([
      remoto('r1', 'Cabo 2,5mm'),
      remoto('r2', 'Fita isolante', { ativo: false }),
      remoto('r3', 'Conector', { disponivel_pdv: false }),
      remoto('r4', 'Tomada'),
    ]);
    return env;
  }

  test('busca por remote_id, nao pelo id local', () => {
    // O servidor fala em uuid do Supabase; o id local é outro. Confundir os
    // dois devolveria lista vazia sem erro nenhum.
    const { db } = catalogo();
    const achados = db.produtos.porRemoteIds(['r1', 'r4']);
    assert.deepEqual(achados.map(p => p.nome).sort(), ['Cabo 2,5mm', 'Tomada']);
    assert.ok(achados.every(p => p.id !== p.remote_id), 'id local deveria ser diferente do remoto');
  });

  test('descarta inativo e indisponivel no PDV', () => {
    const { db } = catalogo();
    assert.deepEqual(db.produtos.porRemoteIds(['r2', 'r3']), []);
  });

  test('id desconhecido nao quebra nem inventa linha', () => {
    const { db } = catalogo();
    assert.deepEqual(db.produtos.porRemoteIds(['r1', 'nao-existe']).map(p => p.nome), ['Cabo 2,5mm']);
  });

  test('lista vazia ou so nulos devolve vazio', () => {
    const { db } = catalogo();
    for (const v of [[], null, undefined, [null, '']]) {
      assert.deepEqual(db.produtos.porRemoteIds(v), [], `falhou para ${JSON.stringify(v)}`);
    }
  });

  test('traz estoque junto — é o que decide a ordem dos cards', () => {
    const { db } = catalogo();
    assert.equal(db.produtos.porRemoteIds(['r1'])[0].estoque, 5);
  });
});

suite('a busca acha pela marca', () => {
  function loja() {
    const env = ambiente();
    env.db.produtos.upsertBatch([
      remoto('r1', 'Cabo flexivel 2,5mm', { marca: 'Philips' }),
      remoto('r2', 'Cabo flexivel 4mm',   { marca: 'Sil' }),
      remoto('r3', 'Lampada LED 9W',      { marca: 'Philips' }),
    ]);
    return env;
  }

  test('uma palavra: a marca ja contava', () => {
    const { db } = loja();
    assert.equal(db.produtos.buscar('philips').length, 2);
  });

  test('VARIAS palavras: nome + marca juntos', () => {
    // Era o buraco: "cabo philips" exigia as duas palavras no NOME e nao
    // achava nada. Marca é parte de como o vendedor nomeia o produto.
    const { db } = loja();
    const achados = db.produtos.buscar('cabo philips').map(p => p.nome);
    assert.deepEqual(achados, ['Cabo flexivel 2,5mm']);
  });

  test('e continua exigindo TODAS as palavras', () => {
    const { db } = loja();
    assert.deepEqual(db.produtos.buscar('cabo xyz'), []);
  });
});

suite('a origem do item sobrevive ate o banco', () => {
  function vendaCom(origem) {
    const env = ambiente();
    env.db.produtos.upsertBatch([remoto('r1', 'Cabo')]);
    const prod = env.bruto.prepare('SELECT id FROM produtos WHERE remote_id = ?').get('r1');
    const res = env.db.vendas.registrar({
      empresa_id: 'emp-1', subtotal: 10, desconto: 0, total: 10,
      forma_pagamento: 'dinheiro', valor_pago: 10, troco: 0, _numero_base: 100000,
      itens: [{ produto_id: prod.id, produto_nome: 'Cabo', quantidade: 1,
                preco_unitario: 10, desconto: 0, total: 10, origem_sugestao: origem }],
    });
    return { env, res };
  }

  test('item clicado na sugestao fica marcado', () => {
    const { env, res } = vendaCom('compre_junto');
    const item = env.bruto.prepare(
      'SELECT origem_sugestao FROM venda_itens WHERE venda_id = ?').get(res.id);
    assert.equal(item.origem_sugestao, 'compre_junto');
  });

  test('item buscado na mao fica NULL, nao "manual"', () => {
    // Null é a verdade: ninguem afirmou nada sobre a origem dele.
    const { env, res } = vendaCom(null);
    const item = env.bruto.prepare(
      'SELECT origem_sugestao FROM venda_itens WHERE venda_id = ?').get(res.id);
    assert.equal(item.origem_sugestao, null);
  });

  test('e chega ao payload da venda', () => {
    const { env, res } = vendaCom('compre_junto');
    const venda = env.db.vendas.getById(res.id);
    assert.equal(venda.itens[0].origem_sugestao, 'compre_junto');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// O QUE O CODIGO PROMETE — sem banco, sempre roda
// ─────────────────────────────────────────────────────────────────────────
const semComentarios = (t) => t.replace(/\/\/[^\n]*/g, '');

describe('a leitura do Compre Junto', () => {
  const API = semComentarios(
    fs.readFileSync(path.resolve(__dirname, '../src/main/api.js'), 'utf8'));
  const fn = API.slice(API.indexOf('async function buscarCompreJunto'),
                       API.indexOf('// ─── Autenticação PDV'));

  test('o recorte da funcao nao é vazio', () => {
    assert.ok(fn.length > 600, `fn=${fn.length}`);
  });

  test('falhar e nao ter o que sugerir sao respostas DIFERENTES', () => {
    // `null` = nao deu para perguntar, e a tela cai no painel local.
    // `[]`   = nao ha o que sugerir, e o painel sai da tela.
    // Trocar um pelo outro esconderia queda de rede atras de "sem sugestoes".
    assert.match(fn, /if \(!r\.ok\) \{[\s\S]{0,300}return null;/);
    assert.match(fn, /if \(encerrou \|\| !r\) return null;/);
    assert.match(fn, /return Array\.isArray\(r\.dados\?\.sugestoes\) \? r\.dados\.sugestoes : \[\]/);
  });

  test('tem prazo, e curto — sugestao nao segura o caixa', () => {
    assert.match(API, /const COMPRE_JUNTO_TIMEOUT_MS = 2000;/);
    assert.match(fn, /Promise\.race\(\[pedido, prazo\]\)/);
  });

  test('so manda uuid, e no maximo 50', () => {
    // A rota recusa o pedido INTEIRO com 400 se um id nao for uuid. Um
    // produto criado offline, ainda sem remote_id, nao pode derrubar a
    // consulta dos outros.
    assert.match(fn, /\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}/);
    assert.match(fn, /uuids\.slice\(0, 50\)/);
  });

  test('vai pela rota autenticada, por GET', () => {
    assert.match(fn, /chamarProtegida\(`\/api\/pdv\/compre-junto\?\$\{qs\}`, null, \{ metodo: 'GET' \}\)/);
  });
});

describe('o catalogo pede o campo novo', () => {
  const API = fs.readFileSync(path.resolve(__dirname, '../src/main/api.js'), 'utf8');
  const SYNC = fs.readFileSync(path.resolve(__dirname, '../src/main/sync.js'), 'utf8');

  test('a rota de produtos manda campos=v2', () => {
    assert.match(API, /new URLSearchParams\(\{ pagina: String\(pagina\), campos: 'v2' \}\)/);
  });

  test('a de clientes NAO manda — o parametro é so do catalogo', () => {
    const clientes = API.slice(API.indexOf('api/pdv/clientes') - 2000);
    assert.doesNotMatch(clientes, /campos: 'v2'/);
  });

  test('o mapeamento carrega o grupo', () => {
    assert.match(SYNC, /grupo_similar: p\.grupo_similar \?\? null/);
  });

  test('uma carga completa, UMA vez, depois do rollout', () => {
    // O incremental so resgata quem teve `updated_at` tocado depois do
    // checkpoint local. Produto agrupado ANTES de a coluna existir ficaria
    // sem grupo para sempre, e o modal nunca abriria para ele.
    assert.match(SYNC, /const forcarBackfillGrupo = !store\.get\('sync\.produtos_grupo_similar_backfill_v1'\)/);
    assert.match(SYNC, /if \(forcarBackfillGrupo\) ultimaSync = null;/);
    assert.match(SYNC, /if \(forcarBackfillGrupo\) store\.set\('sync\.produtos_grupo_similar_backfill_v1', true\)/);
  });
});

// O bloco que conferia o payload V1 NAO existe nesta linha: a 1.11.x e a
// versao da loja, sem o cliente transacional. O campo origem_sugestao viaja
// pelo caminho legado, que e o unico aqui — e isso esta coberto pelo teste de
// banco acima e pelo payload em api.js.
describe('a tela', () => {
  const UI = fs.readFileSync(path.resolve(__dirname, '../src/renderer/pages/pdv.js'), 'utf8');
  const codigo = semComentarios(UI);

  test('a escolha pela lista passa pelo filtro de similares', () => {
    assert.match(codigo, /onclick="\$\{!semEstoque \? `PDV\.escolherDaLista\(/);
    assert.match(codigo, /escolherDaLista\(searchResults\[searchHighlight\]\)/);
    assert.match(codigo, /escolherDaLista\(searchResults\[0\]\)/);
  });

  test('EAN ou SKU digitado NAO abre o modal', () => {
    // Quem bipou ou digitou o SKU ja disse qual marca quer; parar o caixa aí
    // so atrasaria.
    const fn = codigo.slice(codigo.indexOf('function _termoIdentificaMarca'),
                            codigo.indexOf('async function escolherDaLista'));
    assert.ok(fn.length > 200, `fn=${fn.length}`);
    assert.match(fn, /t === ean/);
    assert.match(fn, /t === sku/);
    assert.match(codigo, /if \(!produto\.grupo_similar \|\| _termoIdentificaMarca\(produto, termo\)\)/);
  });

  test('menos de dois, ou erro, segue a venda', () => {
    // O modal é ajuda. Nunca pode ser o motivo de a venda nao andar.
    const fn = codigo.slice(codigo.indexOf('async function escolherDaLista'),
                            codigo.indexOf('function _abrirModalSimilares'));
    assert.ok(fn.length > 400, `fn=${fn.length}`);
    assert.match(fn, /if \(opcoes\.length < 2\) \{ selecionarProduto\(produto\); return; \}/);
    assert.match(fn, /catch[\s\S]{0,200}selecionarProduto\(produto\);[\s\S]{0,40}return;/);
  });

  test('o teclado do modal: setas, Enter, 1-9 e Esc', () => {
    const fn = codigo.slice(codigo.indexOf('function _onSimilaresKey'));
    assert.ok(fn.length > 500, `fn=${fn.length}`);
    for (const tecla of [/'ArrowDown'/, /'ArrowUp'/, /'Enter'/, /\^\[1-9\]\$/, /'Escape'/]) {
      assert.match(fn, tecla);
    }
  });

  test('o selo aparece na lista da busca', () => {
    assert.match(codigo, /p\.grupo_similar \? ' <span class="si-selo-similar">/);
  });

  test('devolucao nao gera sugestao', () => {
    // Quem esta devolvendo nao esta comprando.
    const fn = codigo.slice(codigo.indexOf('async function renderSugestoes'),
                            codigo.indexOf('async function _montarCardsCompreJunto'));
    assert.ok(fn.length > 400, `fn=${fn.length}`);
    assert.match(fn, /cart\.filter\(i => !i\.devolucao\)/);
  });

  test('servidor mudo cai no painel local; resposta vazia esconde', () => {
    const fn = codigo.slice(codigo.indexOf('async function renderSugestoes'),
                            codigo.indexOf('async function _montarCardsCompreJunto'));
    assert.match(fn, /if \(sugestoes === null\) \{ await _renderSugestoesLocais\(\); return; \}/);
    assert.match(fn, /if \(cards\.length === 0\) \{ wrap\.style\.display = 'none'; return; \}/);
  });

  test('resposta atrasada de um carrinho antigo é descartada', () => {
    // Sem isto, digitar rapido faria a sugestao de tres itens atras aparecer
    // por cima da atual.
    const fn = codigo.slice(codigo.indexOf('async function renderSugestoes'),
                            codigo.indexOf('async function _montarCardsCompreJunto'));
    assert.match(fn, /const token = \+\+_compreJuntoToken;/);
    assert.match(fn, /if \(token !== _compreJuntoToken\) return;/);
  });

  test('o que ja esta no carrinho nao é sugerido', () => {
    const fn = codigo.slice(codigo.indexOf('async function _montarCardsCompreJunto'),
                            codigo.indexOf('function _dispensarSugestao'));
    assert.ok(fn.length > 600, `fn=${fn.length}`);
    assert.match(fn, /if \(noCarrinho\.has\(s\.produto_id\)\) continue;/);
  });

  test('com estoque primeiro, no maximo 6', () => {
    const fn = codigo.slice(codigo.indexOf('async function _montarCardsCompreJunto'),
                            codigo.indexOf('function _dispensarSugestao'));
    assert.match(fn, /lista\.sort\(\(a, b\) => Number\(b\.estoque > 0\) - Number\(a\.estoque > 0\)\)/);
    assert.match(fn, /lista\.slice\(0, 6\)/);
  });

  test('o clique adiciona 1 unidade com a origem', () => {
    const fn = codigo.slice(codigo.indexOf('async function adicionarSugestao'),
                            codigo.indexOf('function promocaoVigente'));
    assert.ok(fn.length > 250, `fn=${fn.length}`);
    assert.match(fn, /addToCartConfirmado\(produto, 1, preco, false, origem\)/);
    assert.match(codigo, /origem = 'compre_junto'/);
  });

  test('dispensar vale so nesta venda', () => {
    assert.match(codigo, /_dispensadas\.add\(remoteId\)/);
    assert.match(codigo, /_dispensadas = new Set\(\);/);
  });

  test('o item do carrinho leva o id remoto e a origem', () => {
    assert.match(codigo, /produto_remote_id: produto\.remote_id \|\| null/);
    assert.match(codigo, /origem_sugestao: origemSugestao/);
    assert.match(codigo, /origem_sugestao: i\.origem_sugestao \|\| null/);
  });
});

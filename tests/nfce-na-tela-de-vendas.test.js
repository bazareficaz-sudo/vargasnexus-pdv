const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A NOTA NA TELA DE VENDAS.
//
// O relato do balcao, 16/11/2026: a nota foi emitida pela barra azul ("Emitir
// NFC-e Selecionadas"), deu certo -- e nao havia botao nenhum para imprimir o
// cupom fiscal, nem para informar o CPF do cliente.
//
// A causa nao era a nota: era ONDE os dois botoes estavam. Eles moravam no
// ramo que a tela so desenha para venda que existe no SQLite DESTA maquina,
// junto com imprimir, editar e cancelar -- que de fato precisam do registro
// local. Emitir e reimprimir nao precisam: quem emite e o servidor, e o que
// ele quer e o id da venda na nuvem.
//
// Resultado: no caixa, olhando a lista com as vendas de todos os balcoes, os
// dois botoes nunca apareciam. O unico caminho que sobrava era a barra azul,
// que e o caminho de LOTE -- e lote nao pergunta documento, de proposito.

const raiz = (...p) => path.resolve(__dirname, '..', ...p);
const COMPONENTS = fs.readFileSync(raiz('src/renderer/styles/components.js'), 'utf8');

/** Recorta uma funcao do fonte contando chaves a partir do corpo. */
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

// ─── onde os botoes de nota moram ────────────────────────────────────────

describe('a linha da venda oferece a nota venha ela de onde vier', () => {
  const linha = COMPONENTS.slice(
    COMPONENTS.indexOf('const podeEmitir ='),
    COMPONENTS.indexOf('</tr>`;', COMPONENTS.indexOf('const podeEmitir =')),
  );

  test('as acoes de nota sao calculadas FORA do ramo "so local"', () => {
    const posAcoes = COMPONENTS.indexOf('const acoesNfce =');
    const posRamo = COMPONENTS.indexOf('${nuvem', posAcoes);
    assert.ok(posAcoes > 0 && posRamo > posAcoes, 'acoesNfce tem que ser calculada antes do ramo nuvem/local');
  });

  test('e entram nos DOIS ramos — nuvem e local', () => {
    const ramo = COMPONENTS.slice(COMPONENTS.indexOf('${nuvem'), COMPONENTS.indexOf('</tr>`;', COMPONENTS.indexOf('${nuvem')));
    assert.equal(ramo.split('${acoesNfce}').length - 1, 2, 'acoesNfce precisa aparecer uma vez em cada ramo');
  });

  test('nao sobrou botao de nota preso ao registro local', () => {
    // O padrao antigo: o bloco de NFC-e escrito dentro do ramo local.
    assert.doesNotMatch(COMPONENTS, /\$\{!cancelada && v\.nfce_emitida/);
  });

  test('emitir depende da politica da loja; reimprimir, da liberacao do terminal', () => {
    assert.match(linha, /podeEmitir = this\._politicaFiscal\?\.emitir_no_balcao === true/);
    assert.match(linha, /podeVerCupom = this\._politicaFiscal\?\.terminal_liberado === true/);
    // O botao de emitir so existe se a loja emite no balcao...
    assert.match(linha, /podeEmitir \? `<button[^`]*Vendas\.emitirNFCe/);
    // ...e o de reimprimir, se o terminal esta liberado (e a rota do cupom
    // atras da mesma flag que a da emissao).
    assert.match(linha, /podeVerCupom \? `<button[^`]*Vendas\.imprimirNota/);
  });

  test('venda cancelada nao oferece nota nenhuma', () => {
    assert.match(linha, /const acoesNfce = cancelada \? ''/);
  });

  test('venda que ja tem nota mostra o selo e NAO oferece emitir de novo', () => {
    const i = linha.indexOf('v.nfce_emitida');
    const seloAntes = linha.indexOf('✅ NFC-e', i);
    const emitirDepois = linha.indexOf('Vendas.emitirNFCe', i);
    assert.ok(seloAntes > 0 && emitirDepois > seloAntes, 'emitir fica no ramo do else');
  });

  test('a politica entra na tela pelo load, sem chamada de rede por linha', () => {
    const load = extrair(COMPONENTS.slice(COMPONENTS.indexOf('_politicaFiscal: {')), 'async load(opts = {})');
    assert.match(load, /await window\.pdv\.nfce\.politica\(\)/);
    assert.match(load, /if \(p\) this\._politicaFiscal = p/);
    assert.equal((load.match(/nfce\.politica\(\)/g) || []).length, 1, 'uma consulta por carga, nao uma por venda');
  });

  test('antes da primeira resposta, a tela nao promete nota', () => {
    const inicial = COMPONENTS.slice(COMPONENTS.indexOf('_politicaFiscal: {'), COMPONENTS.indexOf('_politicaFiscal: {') + 220);
    assert.match(inicial, /emitir_no_balcao: false/);
    assert.match(inicial, /terminal_liberado: false/);
  });
});

// ─── uma venda marcada nao e lote ────────────────────────────────────────

function montarLote(fakes) {
  const ctx = {
    window: { pdv: { nfce: fakes.nfce, app: fakes.app } },
    Toast: { show: (m) => fakes.toasts.push(m) },
    console: { warn() {}, error() {} },
    module: {},
  };
  vm.createContext(ctx);
  vm.runInContext(`module.fn = { ${extrair(COMPONENTS, 'async nfceLote()')} };`, ctx);
  const alvo = {
    _sel: new Set(fakes.selecionadas),
    _atualizarBarraSel() { fakes.barraAtualizada = true; },
    load: async () => { fakes.recarregou = true; },
    emitirNFCe: async (id) => { fakes.delegou.push(id); },
    nfceLote: ctx.module.fn.nfceLote,
  };
  return alvo;
}

function fakesPadrao(selecionadas) {
  return {
    selecionadas,
    toasts: [], delegou: [], emitidas: [],
    barraAtualizada: false, recarregou: false, confirmou: false,
    app: { confirm: async function () { this.confirmou = true; return true; } },
    nfce: { politica: async () => ({ emitir_no_balcao: true, pedir_documento: true }), emitir: async () => ({ ok: true }) },
  };
}

describe('a barra azul com UMA venda marcada', () => {
  test('manda para o caminho da linha — que pergunta o documento e imprime', async () => {
    const f = fakesPadrao(['venda-1']);
    f.app.confirm = async () => { f.confirmou = true; return true; };
    const alvo = montarLote(f);
    await alvo.nfceLote.call(alvo);

    assert.deepEqual(f.delegou, ['venda-1']);
    assert.equal(f.confirmou, false, 'nao pergunta "emitir para 1 venda?" antes de perguntar o CPF');
    assert.equal(f.emitidas.length, 0, 'o lote nao emite por conta propria neste caso');
  });

  test('limpa a selecao antes de delegar — senao a barra azul fica no ar', async () => {
    const f = fakesPadrao(['venda-1']);
    const alvo = montarLote(f);
    await alvo.nfceLote.call(alvo);
    assert.equal(alvo._sel.size, 0);
    assert.equal(f.barraAtualizada, true);
  });

  test('sem nada marcado, nao faz nada', async () => {
    const f = fakesPadrao([]);
    const alvo = montarLote(f);
    await alvo.nfceLote.call(alvo);
    assert.deepEqual(f.delegou, []);
    assert.equal(f.confirmou, false);
  });
});

describe('a barra azul com VARIAS vendas', () => {
  test('continua sendo lote: confirma, nao delega e nao pergunta documento', async () => {
    const f = fakesPadrao(['v1', 'v2', 'v3']);
    const emitidas = [];
    f.nfce.emitir = async (id, doc) => { emitidas.push([id, doc]); return { ok: true }; };
    const alvo = montarLote(f);
    await alvo.nfceLote.call(alvo);

    assert.deepEqual(f.delegou, [], 'tres vendas nao viram tres perguntas de CPF');
    assert.equal(emitidas.length, 3);
    assert.deepEqual(emitidas.map(e => e[1]), [null, null, null], 'lote emite sem documento, de proposito');
    assert.equal(f.recarregou, true);
  });

  test('politica desligada barra o lote antes de emitir qualquer uma', async () => {
    const f = fakesPadrao(['v1', 'v2']);
    f.nfce.politica = async () => ({ emitir_no_balcao: false });
    const emitidas = [];
    f.nfce.emitir = async (id) => { emitidas.push(id); return { ok: true }; };
    const alvo = montarLote(f);
    await alvo.nfceLote.call(alvo);
    assert.equal(emitidas.length, 0);
    assert.match(f.toasts.join(' | '), /desligada/);
  });
});

// ─── o contrato entre quem le e quem entrega a politica ──────────────────
//
// O relato de 16/11/2026, com a 1.18.1 ja instalada no caixa: a nota emite,
// imprime na hora, a linha mostra "✅ NFC-e" -- e nao ha onde pedir a segunda
// via. Clicar no selo verde nao faz nada, porque selo nao e botao.
//
// O botao de reimprimir existia no fonte desde a 1.18.1, atras de
// `_politicaFiscal.terminal_liberado`. O campo vinha do servidor, que o manda
// certo, mas `nfce.politica()` normaliza a resposta campo a campo e nao
// copiava esse. A tela lia `undefined`, e `undefined === true` e falso em
// todo terminal, de toda loja, sempre.
//
// O teste da 1.18.1 afirmava a LINHA da tela. Faltava afirmar que o dado que
// a linha le chega ate ela. E o que estes dois testes fazem: varrem os campos
// que a tela consulta e exigem que cada um exista nos dois lugares que os
// produzem -- o normalizador e o padrao de quem nunca sincronizou.

describe('todo campo que a tela le da politica chega ate ela', () => {
  const NFCE = fs.readFileSync(raiz('src/main/nfce.js'), 'utf8');
  const MAIN = fs.readFileSync(raiz('src/main/main.js'), 'utf8');

  /** Os campos que a tela de Vendas consulta em `_politicaFiscal`. */
  const camposLidos = [...new Set(
    [...COMPONENTS.matchAll(/_politicaFiscal\?\.([a-z_]+)/g)].map(m => m[1]),
  )];

  test('a tela le pelo menos os dois interruptores que decidem os botoes', () => {
    assert.ok(camposLidos.includes('emitir_no_balcao'), camposLidos.join(','));
    assert.ok(camposLidos.includes('terminal_liberado'), camposLidos.join(','));
  });

  test('`nfce.politica()` devolve todos eles', () => {
    const fn = extrair(NFCE, 'async function politica(');
    for (const campo of camposLidos) {
      assert.match(fn, new RegExp(`${campo}: `), `politica() nao devolve "${campo}" -- a tela vai ler undefined`);
    }
  });

  test('o padrao de quem nunca sincronizou tambem os traz, todos em false', () => {
    const handler = extrair(MAIN, "ipcMain.handle('nfce:politica'");
    const padrao = handler.slice(handler.lastIndexOf('return {'));
    for (const campo of camposLidos) {
      assert.match(padrao, new RegExp(`${campo}: false`), `o padrao nao traz "${campo}": false`);
    }
  });

  test('politica guardada pela versao anterior nao esconde o botao ate o proximo sync', () => {
    const handler = extrair(MAIN, "ipcMain.handle('nfce:politica'");
    assert.match(handler, /'terminal_liberado' in guardada/);
    assert.match(handler, /terminal_liberado: guardada\.emitir_no_balcao === true/);
  });
});

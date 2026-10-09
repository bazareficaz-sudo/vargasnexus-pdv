const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { criarCompreJunto } = require('../src/main/compreJunto');

// COMPRE JUNTO DA LOJA INTEIRA, SEM SEGURAR O CARRINHO.
//
// A sugestão local só via as vendas deste terminal. A rota do servidor vê a
// loja toda e os "fixar"/"ocultar" do cadastro. O que estes testes travam:
// sem resposta do servidor, `null` (e o painel cai no local); com resposta,
// os dados de preço e estoque vêm do catálogo LOCAL; e o painel, que é
// redesenhado a cada mudança de quantidade, não pergunta de novo à toa.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const CATALOGO = {
  [B]: { id: B, nome: 'CIMENTO 1KG', emoji: '🧱', preco_venda: 9.9, estoque: 0, ativo: 1, disponivel_pdv: 1 },
  [C]: { id: C, nome: 'PARAFUSO', emoji: null, preco_venda: 0.5, estoque: 100, ativo: 1, disponivel_pdv: 1 },
  [D]: { id: D, nome: 'FORA DO PDV', preco_venda: 1, estoque: 5, ativo: 1, disponivel_pdv: 0 },
};

function montar({ resposta, agora = () => 0, timeoutMs } = {}) {
  const chamadas = [];
  const cj = criarCompreJunto({
    chamar: async (ids, limite) => { chamadas.push({ ids, limite }); return typeof resposta === 'function' ? resposta() : resposta; },
    getProduto: (id) => CATALOGO[id],
    agora,
    timeoutMs,
  });
  return { cj, chamadas };
}

const ok = (sugestoes) => ({ ok: true, dados: { ok: true, sugestoes } });

describe('resposta do servidor', () => {
  test('monta com nome, preço e estoque do catálogo local; com estoque primeiro', async () => {
    const { cj } = montar({ resposta: ok([
      { produto_id: B, base_id: A, vezes: 45, fixo: false },
      { produto_id: C, base_id: A, vezes: 10, fixo: true },
    ]) });
    const r = await cj.sugerir([A]);
    assert.deepEqual(r.map((s) => s.id), [C, B], 'com estoque vem antes');
    assert.equal(r[1].preco, 9.9);
    assert.equal(r[1].vezes, 45);
    assert.equal(r[0].fixo, true);
    assert.equal(r[0].base_id, A);
  });

  test('não oferece o que o terminal não vende (fora do PDV ou fora do catálogo local)', async () => {
    const { cj } = montar({ resposta: ok([
      { produto_id: D, base_id: A, vezes: 9, fixo: false },
      { produto_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', base_id: A, vezes: 9, fixo: false },
    ]) });
    assert.deepEqual(await cj.sugerir([A]), []);
  });

  test('lista vazia do servidor é lista vazia, não null', async () => {
    const { cj } = montar({ resposta: ok([]) });
    assert.deepEqual(await cj.sugerir([A]), []);
  });
});

describe('sem resposta: null, e o painel usa a sugestão local', () => {
  for (const [nome, resposta] of [
    ['offline', { ok: false, motivo: 'rede' }],
    ['terminal sem identidade', { ok: false, motivo: 'sem_identidade' }],
    ['rota ainda não publicada (404)', { ok: false, motivo: 'resposta_invalida' }],
    ['resposta sem lista', { ok: true, dados: { ok: true } }],
    ['exceção', () => { throw new Error('boom'); }],
  ]) {
    test(nome, async () => {
      const { cj } = montar({ resposta });
      assert.equal(await cj.sugerir([A]), null);
    });
  }

  test('servidor lento: desiste no timeout', async () => {
    const { cj } = montar({ resposta: () => new Promise(() => {}), timeoutMs: 20 });
    assert.equal(await cj.sugerir([A]), null);
  });

  test('carrinho sem nenhum id do servidor nem pergunta', async () => {
    const { cj, chamadas } = montar({ resposta: ok([]) });
    assert.equal(await cj.sugerir(['local-123', '64f1a2b3c4d5e6f7a8b9c0d1']), null);
    assert.equal(chamadas.length, 0);
  });
});

describe('não pergunta de novo à toa', () => {
  test('mesmo carrinho (em qualquer ordem, com repetição) usa a resposta lembrada', async () => {
    const { cj, chamadas } = montar({ resposta: ok([{ produto_id: C, base_id: A, vezes: 3, fixo: false }]) });
    await cj.sugerir([A, B]);
    await cj.sugerir([B, A, A]);
    assert.equal(chamadas.length, 1);
    assert.deepEqual(chamadas[0].ids, [A, B]);
  });

  test('estoque local é relido mesmo com a resposta lembrada', async () => {
    const { cj } = montar({ resposta: ok([{ produto_id: C, base_id: A, vezes: 3, fixo: false }]) });
    await cj.sugerir([A]);
    CATALOGO[C].estoque = 7;
    assert.equal((await cj.sugerir([A]))[0].estoque, 7);
    CATALOGO[C].estoque = 100;
  });

  test('a resposta vence em 5 minutos', async () => {
    let t = 0;
    const { cj, chamadas } = montar({ resposta: ok([]), agora: () => t });
    await cj.sugerir([A]);
    t = 5 * 60 * 1000 - 1; await cj.sugerir([A]);
    assert.equal(chamadas.length, 1);
    t = 5 * 60 * 1000 + 1; await cj.sugerir([A]);
    assert.equal(chamadas.length, 2);
  });

  test('a falha é lembrada por 1 minuto: offline, o painel não espera o timeout a cada redesenho', async () => {
    let t = 0;
    const { cj, chamadas } = montar({ resposta: { ok: false, motivo: 'rede' }, agora: () => t });
    await cj.sugerir([A]);
    t = 59 * 1000; assert.equal(await cj.sugerir([A]), null);
    assert.equal(chamadas.length, 1);
    t = 61 * 1000; await cj.sugerir([A]);
    assert.equal(chamadas.length, 2);
  });
});

// ── Ligações (estruturais: dependem do Electron) ─────────────────────────
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const ler = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').split(CR + LF).join(LF);

describe('ligações', () => {
  test('api.js chama a rota autenticada por GET, sem caminho anônimo', () => {
    const api = ler('src/main/api.js');
    const ini = api.indexOf('async function buscarCompreJunto(');
    const fn = api.slice(ini, api.indexOf(LF + '}' + LF, ini));
    assert.match(fn, /chamarProtegida\(`\/api\/pdv\/compre-junto\?\$\{qs\}`, null, \{ metodo: 'GET' \}\)/);
    assert.ok(!/supabase\./.test(fn));
  });

  test('o painel pergunta ao servidor primeiro e cai na sugestão local', () => {
    const pdv = ler('src/renderer/pages/pdv.js');
    const ini = pdv.indexOf('async function renderSugestoes(');
    const fn = pdv.slice(ini, pdv.indexOf('function _desenharSugestoes(', ini));
    const iServidor = fn.indexOf('sugestoes.compreJunto(');
    const iLocal = fn.indexOf('sugestoes.porCarrinho(');
    assert.ok(iServidor > 0 && iLocal > iServidor);
    // resposta velha não sobrescreve carrinho novo
    assert.ok((fn.match(/seq !== _seqSugestoes/g) || []).length >= 3);
  });
});

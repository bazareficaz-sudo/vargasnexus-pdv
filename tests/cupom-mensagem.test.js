const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

// MENSAGEM NO RODAPE DO CUPOM DE VENDA.
//
// Antes o rodape era fixo no codigo: "Obrigado pela preferencia!". Agora sai
// de `config.cupom_mensagem`, no store do terminal, do lado de
// `cupom_layout`.
//
// O que estes testes travam: o padrao de quem nunca configurou, o escape do
// texto digitado, e a diferenca entre "nao configurado" e "configurado como
// vazio" — que sao coisas distintas.

// `print-server.js` monta um Store de verdade no topo. Carregamos o modulo
// com `electron-store` substituido para poder ditar a configuracao.
function carregarComStore(config) {
  const filename = path.resolve(__dirname, '../src/main/print-server.js');
  const req = Module.createRequire(filename);
  const mod = { exports: {} };
  const StoreFalso = class {
    get(chave) { return config[chave]; }
    set() {}
  };
  const mocks = {
    'electron-store': StoreFalso,
    electron: { app: { getPath: () => require('node:os').tmpdir(), isPackaged: false },
                BrowserWindow: class {}, ipcMain: { handle() {}, on() {} } },
  };
  const exec = vm.runInThisContext(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename });
  exec(mod.exports, n => Object.hasOwn(mocks, n) ? mocks[n] : req(n), mod, filename, path.dirname(filename));
  return mod.exports;
}

const venda = {
  numero: 1, empresa_nome: 'LOJA', total: 10, subtotal: 10,
  forma_pagamento: 'dinheiro', valor_pago: 10, troco: 0,
  itens: [{ produto_nome: 'ITEM', quantidade: 1, preco_unitario: 10, total: 10 }],
};

describe('mensagem no rodape do cupom', () => {
  test('sem configuracao, mantem o texto de sempre', () => {
    // Quem nunca abriu a tela nao pode perder o rodape que ja tinha.
    const { gerarHtmlCupom } = carregarComStore({});
    assert.match(gerarHtmlCupom(venda), /Obrigado pela preferencia!/);
  });

  test('mensagem configurada aparece no lugar', () => {
    const { gerarHtmlCupom } = carregarComStore({
      'config.cupom_mensagem': 'Trocas em ate 7 dias com o cupom',
    });
    const html = gerarHtmlCupom(venda);
    assert.match(html, /Trocas em ate 7 dias com o cupom/);
    assert.doesNotMatch(html, /Obrigado pela preferencia!/);
  });

  test('varias linhas sao preservadas na impressao', () => {
    const { gerarHtmlCupom } = carregarComStore({
      'config.cupom_mensagem': 'Trocas em ate 7 dias\nWhatsApp 99999-9999\nSeg a Sab, 8h as 18h',
    });
    const html = gerarHtmlCupom(venda);
    assert.match(html, /white-space:pre-line/);
    assert.match(html, /WhatsApp 99999-9999/);
    assert.match(html, /Seg a Sab, 8h as 18h/);
  });

  test('string VAZIA nao imprime rodape — é escolha, nao ausencia', () => {
    // Diferente de "nao configurado". Quem apagou o campo quer o cupom sem
    // rodape, e `??` no carregamento preserva essa diferenca.
    const { gerarHtmlCupom } = carregarComStore({ 'config.cupom_mensagem': '' });
    const html = gerarHtmlCupom(venda);
    assert.doesNotMatch(html, /Obrigado pela preferencia!/);
    assert.doesNotMatch(html, /white-space:pre-line/);
  });

  test('so espacos equivale a vazio', () => {
    const { gerarHtmlCupom } = carregarComStore({ 'config.cupom_mensagem': '   \n  ' });
    assert.doesNotMatch(gerarHtmlCupom(venda), /white-space:pre-line/);
  });

  test('o texto digitado é ESCAPADO antes de entrar no HTML', () => {
    // Sem escape, um `<` perdido quebraria o layout impresso.
    const { gerarHtmlCupom } = carregarComStore({
      'config.cupom_mensagem': 'Promo <b>50%</b> & "cia"',
    });
    const html = gerarHtmlCupom(venda);
    assert.match(html, /Promo &lt;b&gt;50%&lt;\/b&gt; &amp; &quot;cia&quot;/);
    assert.doesNotMatch(html, /<b>50%<\/b>/);
  });

  test('o resto do cupom nao mudou', () => {
    const { gerarHtmlCupom } = carregarComStore({ 'config.cupom_mensagem': 'oi' });
    const html = gerarHtmlCupom(venda);
    assert.match(html, /LOJA/);
    assert.match(html, /ITEM/);
    assert.match(html, /10,00/);
  });
});

describe('a tela de configuracao', () => {
  const UI = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/styles/components.js'), 'utf8');

  test('tem o campo de mensagem', () => {
    assert.match(UI, /id="cfg-cupom-mensagem"/);
    assert.match(UI, /maxlength="300"/);
  });

  test('carrega com ?? e nao com || — vazio é escolha valida', () => {
    assert.match(UI, /config\.get\('config\.cupom_mensagem'\)\s*\n?\s*\?\?/);
  });

  test('salva o que foi digitado, limitado a 300', () => {
    assert.match(UI, /config\.set\('config\.cupom_mensagem', mensagem\.slice\(0, 300\)\)/);
  });
});

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

// MENSAGEM NO RODAPE DO CUPOM DE VENDA.
//
// Historia curta: na 1.10.9 a mensagem era so do terminal, guardada em
// `config.cupom_mensagem`. So que o cupom termico e montado por quem IMPRIME,
// e um terminal que manda o job para o CAIXA nunca usa a propria
// configuracao. Com seis terminais, a mesma frase teria que ser digitada seis
// vezes — e o comprovante em PDF ja lia de outro lugar, do servidor.
//
// Agora a mensagem vem da empresa, pelo sync, e o campo local vira
// sobreposicao.
//
// O QUE MUDOU DE SEMANTICA, e esta travado abaixo: campo local em branco
// deixou de significar "cupom sem rodape". Passou a significar "nao
// configurei aqui". Existe UM lugar para desligar o rodape — o da empresa —
// porque duas formas de desligar a mesma coisa so produzem duvida depois.

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

describe('de onde vem a mensagem: sobreposicao, empresa, padrao', () => {
  test('sem nada configurado, mantem o texto de sempre', () => {
    // Quem nunca abriu a tela e cuja empresa nunca configurou nao pode perder
    // o rodape que ja tinha.
    const { gerarHtmlCupom } = carregarComStore({});
    assert.match(gerarHtmlCupom(venda), /Obrigado pela preferencia!/);
  });

  test('a mensagem da EMPRESA vale quando nao ha sobreposicao', () => {
    const { gerarHtmlCupom } = carregarComStore({
      'config.cupom_mensagem_empresa': 'Trocas em ate 7 dias com o cupom',
    });
    const html = gerarHtmlCupom(venda);
    assert.match(html, /Trocas em ate 7 dias com o cupom/);
    assert.doesNotMatch(html, /Obrigado pela preferencia!/);
  });

  test('a sobreposicao do terminal vence a da empresa', () => {
    const { gerarHtmlCupom } = carregarComStore({
      'config.cupom_mensagem_empresa': 'Mensagem da empresa',
      'config.cupom_mensagem': 'So deste balcao',
    });
    const html = gerarHtmlCupom(venda);
    assert.match(html, /So deste balcao/);
    assert.doesNotMatch(html, /Mensagem da empresa/);
  });

  test('sobreposicao EM BRANCO nao desliga o rodape — cai na da empresa', () => {
    // Mudanca de semantica em relacao a 1.10.9, deliberada. Em branco é
    // "nao configurei aqui", nao "quero cupom sem rodape".
    const { gerarHtmlCupom } = carregarComStore({
      'config.cupom_mensagem_empresa': 'Mensagem da empresa',
      'config.cupom_mensagem': '',
    });
    assert.match(gerarHtmlCupom(venda), /Mensagem da empresa/);
  });

  test('so espacos tambem é "nao configurei aqui"', () => {
    const { gerarHtmlCupom } = carregarComStore({
      'config.cupom_mensagem_empresa': 'Mensagem da empresa',
      'config.cupom_mensagem': '   \n  ',
    });
    assert.match(gerarHtmlCupom(venda), /Mensagem da empresa/);
  });

  test('quem desliga o rodape é a EMPRESA, com mensagem vazia', () => {
    // O unico lugar onde vazio quer dizer "sem rodape".
    const { gerarHtmlCupom } = carregarComStore({
      'config.cupom_mensagem_empresa': '',
    });
    const html = gerarHtmlCupom(venda);
    assert.doesNotMatch(html, /Obrigado pela preferencia!/);
    assert.doesNotMatch(html, /white-space:pre-line/);
  });

  test('mas um terminal pode sobrepor uma empresa que desligou', () => {
    const { gerarHtmlCupom } = carregarComStore({
      'config.cupom_mensagem_empresa': '',
      'config.cupom_mensagem': 'Rodape so deste terminal',
    });
    assert.match(gerarHtmlCupom(venda), /Rodape so deste terminal/);
  });
});

describe('a impressao em si', () => {
  test('varias linhas sao preservadas no papel', () => {
    const { gerarHtmlCupom } = carregarComStore({
      'config.cupom_mensagem_empresa': 'Trocas em ate 7 dias\nWhatsApp 99999-9999\nSeg a Sab, 8h as 18h',
    });
    const html = gerarHtmlCupom(venda);
    assert.match(html, /white-space:pre-line/);
    assert.match(html, /WhatsApp 99999-9999/);
    assert.match(html, /Seg a Sab, 8h as 18h/);
  });

  test('o texto é ESCAPADO antes de entrar no HTML', () => {
    // Sem escape, um `<` perdido quebraria o layout impresso. Vale tambem
    // para o que vem do servidor: o terminal nao confia no corpo da resposta.
    const { gerarHtmlCupom } = carregarComStore({
      'config.cupom_mensagem_empresa': 'Promo <b>50%</b> & "cia"',
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

describe('a leitura no servidor', () => {
  const API = fs.readFileSync(
    path.resolve(__dirname, '../src/main/api.js'), 'utf8');
  const SYNC = fs.readFileSync(
    path.resolve(__dirname, '../src/main/sync.js'), 'utf8');
  // Comentarios fora: ancorar em texto de comentario ja produziu assercao
  // vazia neste projeto mais de uma vez.
  const codigo = (t) => t.replace(/\/\/[^\n]*/g, '');

  test('vai pela rota autenticada, nao direto na tabela', () => {
    // `empresa_config_impressao` nao esta aberta ao `anon` — conferido em
    // producao. Ler direto exigiria devolver um privilegio retirado de
    // proposito.
    const api = codigo(API);
    assert.match(api, /chamarProtegida\('\/api\/pdv\/impressao', null, \{ metodo: 'GET' \}\)/);
    assert.doesNotMatch(api, /from\('empresa_config_impressao'\)/);
  });

  test('falha de leitura NAO apaga o que esta guardado', () => {
    // Devolve `undefined`, e o sync nao escreve. Terminal sem identidade,
    // servidor fora ou rota antiga continuam imprimindo o rodape de sempre.
    const api = codigo(API);
    const fn = api.slice(api.indexOf('async function buscarMensagemCupomDaEmpresa'));
    assert.ok(fn.length > 400, `fn=${fn.length}`);
    assert.match(fn, /if \(!r\.ok\) \{[\s\S]{0,400}return undefined;/);
    assert.match(fn, /typeof r\.dados\.cupom !== 'object'[\s\S]{0,80}return undefined/);

    const sync = codigo(SYNC);
    assert.match(sync, /if \(msg === undefined\) return;/);
  });

  test('empresa sem linha (null) é diferente de erro (undefined)', () => {
    const fn = codigo(API);
    assert.match(fn, /if \(msg === null\) return null;/);
  });

  test('o sync guarda em chave PROPRIA e nao toca na sobreposicao', () => {
    // Sobrescrever o que o operador digitou seria decidir por ele, calado.
    const sync = codigo(SYNC);
    const fn = sync.slice(sync.indexOf('async function syncDownConfigCupom'));
    assert.ok(fn.length > 300, `fn=${fn.length}`);
    assert.match(fn, /store\.set\('config\.cupom_mensagem_empresa', msg\)/);
    assert.doesNotMatch(fn, /store\.set\('config\.cupom_mensagem'/);
  });

  test('o CAIXA tambem busca — é ele quem monta o papel', () => {
    // Ao contrario de `syncDownUrlImpressao`, que pula o terminal-servidor.
    const sync = codigo(SYNC);
    const fn = sync.slice(sync.indexOf('async function syncDownConfigCupom'),
                          sync.indexOf('async function syncDownConfigTermometro'));
    assert.ok(fn.length > 300, `fn=${fn.length}`);
    assert.doesNotMatch(fn, /print_server_ativo/);
  });

  test('entra na sequencia do sync', () => {
    assert.match(SYNC, /await syncDownUrlImpressao\(\);\s*\n\s*await syncDownConfigCupom\(\);/);
  });
});

describe('a tela de configuracao', () => {
  const UI = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/styles/components.js'), 'utf8');

  test('o campo esta FORA do bloco que so aparece no CAIXA', () => {
    // Era o defeito: nascido dentro de `cfg-print-server-section`, o campo
    // simplesmente nao existia na tela de um terminal comum.
    const ini = UI.indexOf('id="cfg-print-server-section"');
    const fim = UI.indexOf('id="cfg-tunnel-section"');
    assert.ok(ini > 0 && fim > ini, `ini=${ini} fim=${fim}`);
    const bloco = UI.slice(ini, fim);
    assert.ok(bloco.length > 500, `bloco=${bloco.length}`);
    assert.doesNotMatch(bloco, /cfg-cupom-mensagem/);
  });

  test('tem o campo de sobreposicao, limitado a 300', () => {
    assert.match(UI, /id="cfg-cupom-mensagem"/);
    assert.match(UI, /maxlength="300"/);
    assert.match(UI, /config\.set\('config\.cupom_mensagem', mensagem\.slice\(0, 300\)\)/);
  });

  test('mostra a mensagem da empresa e o que vai sair no papel', () => {
    assert.match(UI, /id="cfg-cupom-empresa"/);
    assert.match(UI, /id="cfg-cupom-efetivo"/);
  });

  test('a tela NAO reimplementa a ordem de precedencia', () => {
    // Ela pergunta ao processo principal. Duas copias da regra divergem, e aí
    // a tela passa a mentir sobre o papel.
    const fn = UI.slice(UI.indexOf('async _pintarCupom()'), UI.indexOf('async salvarCupom()'));
    assert.ok(fn.length > 600, `fn=${fn.length}`);
    assert.match(fn, /await window\.pdv\.print\.mensagemCupom\(\)/);
    assert.doesNotMatch(fn, /Obrigado pela preferencia/);
  });

  test('avisa quem manda o cupom para o CAIXA', () => {
    // Nesse caminho a sobreposicao local nunca sai no papel. Melhor dizer do
    // que deixar o operador digitar uma frase que o CAIXA vai ignorar.
    assert.match(UI, /id="cfg-cupom-aviso"/);
    assert.match(UI, /const enviaFora = !ehServidor && temIp;/);
  });
});

describe('a ponte ate o processo principal', () => {
  const PRELOAD = fs.readFileSync(path.resolve(__dirname, '../src/main/preload.js'), 'utf8');
  const MAIN = fs.readFileSync(path.resolve(__dirname, '../src/main/main.js'), 'utf8');
  const PRINT = fs.readFileSync(path.resolve(__dirname, '../src/main/print-server.js'), 'utf8');

  test('a regra mora junto de quem monta o papel', () => {
    assert.match(PRINT, /function mensagemDoCupom\(\)/);
    assert.match(PRINT, /^\s*mensagemDoCupom,$/m);
    assert.match(PRINT, /const mensagem = String\(mensagemDoCupom\(\)\)\.trim\(\);/);
  });

  test('exposta por IPC e pelo preload', () => {
    assert.match(MAIN, /ipcMain\.handle\('print:mensagem-cupom', \(\) => printServer\.mensagemDoCupom\(\)\)/);
    assert.match(PRELOAD, /mensagemCupom:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('print:mensagem-cupom'\)/);
  });
});

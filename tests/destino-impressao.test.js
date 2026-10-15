const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// PARA ONDE VAI A IMPRESSAO, E O TUNEL QUE SUBIA NA MAO.
//
// Dois relatos do balcao, na mesma conversa:
//
//   1. "o terminal caixa e o servidor de impressao, os cupons de pedido
//      imprimem nele mas os orcamentos nao"
//   2. "no caixa todo dia tem que ir em configuracao e clicar em ativar o
//      tunel de impressao"
//
// O primeiro era tres decisoes diferentes espalhadas pelo codigo:
//
//     cupom de venda   IP preenchido -> servidor   (no RENDERER)
//     entrega          IP preenchido -> servidor   (no main)
//     orcamento        SEMPRE local                 (no main)
//
// O segundo era o servidor de impressao subir no boot e o tunel nao — e o
// Quick Tunnel ganha URL nova a cada reinicio, entao sem o clique diario os
// outros terminais imprimiam em lugar nenhum.

const raiz = path.resolve(__dirname, '..');
const ler = (p) => fs.readFileSync(path.join(raiz, p), 'utf8');
// Comentarios fora: ancorar em comentario ja produziu assercao vazia aqui.
const semComentarios = (t) => t.replace(/\/\/[^\n]*/g, '');

const MAIN = semComentarios(ler('src/main/main.js'));
const PRELOAD = semComentarios(ler('src/main/preload.js'));
const PDV = semComentarios(ler('src/renderer/pages/pdv.js'));
const CFG = ler('src/renderer/styles/components.js');

describe('uma regra so, para os tres documentos', () => {
  const fn = MAIN.slice(MAIN.indexOf('function destinoImpressao()'),
                        MAIN.indexOf("ipcMain.handle('print:destino'"));

  test('o recorte da regra nao é vazio', () => {
    assert.ok(fn.length > 200, `fn=${fn.length}`);
  });

  test('o ORCAMENTO passa a olhar o destino', () => {
    // Era o defeito relatado: ele imprimia sempre local.
    const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('print:orcamento'"),
                         MAIN.indexOf("ipcMain.handle('print:servidor'"));
    assert.ok(h.length > 400, `handler=${h.length}`);
    assert.match(h, /destinoImpressao\(\) === 'servidor'/);
    assert.match(h, /enviarParaServidor\(\{ \.\.\.orc, _html: html \}\)/);
  });

  test('a ENTREGA usa a mesma regra, nao mais o IP cru', () => {
    const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('print:entrega'"),
                         MAIN.indexOf("ipcMain.handle('print:servidor'"));
    assert.ok(h.length > 200, `handler=${h.length}`);
    assert.match(h, /destinoImpressao\(\) === 'servidor'/);
    assert.doesNotMatch(h, /const ip\s+= store\.get/);
  });

  test('a VENDA tambem, e ela estava no renderer', () => {
    // Era a terceira copia da escolha — e a que ignorava a configuracao.
    assert.match(PDV, /await window\.pdv\.print\.destino\(\) === 'servidor'/);
    assert.doesNotMatch(PDV, /config\.get\('config\.print_server_ip'\)/);
    assert.match(PRELOAD, /destino:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('print:destino'\)/);
  });

  test('quem É o servidor imprime em casa', () => {
    // Mandar o job para si mesmo pela internet seria dar a volta ao mundo
    // para chegar na impressora ao lado — e cairia junto com o tunel.
    assert.match(fn, /if \(store\.get\('config\.print_server_ativo'\) === true\) return 'local';/);
  });

  test('sem escolha salva, deduz do que ja estava configurado', () => {
    // Ninguem pode acordar com a impressao em outro lugar depois de atualizar.
    assert.match(fn, /print_server_ip[\s\S]{0,80}\? 'servidor' : 'local'/);
  });

  test('so aceita os dois valores conhecidos', () => {
    // Um valor inventado no store nao pode virar um terceiro comportamento.
    assert.match(fn, /escolhido === 'local' \|\| escolhido === 'servidor'/);
  });

  test('falha no envio cai para local, nao deixa sem papel', () => {
    // O cliente esta na frente esperando. Orcamento impresso na maquina
    // errada é melhor que orcamento nenhum.
    const h = MAIN.slice(MAIN.indexOf("ipcMain.handle('print:orcamento'"),
                         MAIN.indexOf("ipcMain.handle('print:servidor'"));
    assert.match(h, /catch[\s\S]{0,160}imprimindo local/);
  });
});

describe('o tunel sobe com o CAIXA', () => {
  test('existe UMA funcao, usada pelo botao e pelo boot', () => {
    // Duas copias divergiriam, e a que esquecesse de publicar a URL deixaria
    // a loja apontando para um endereco morto.
    assert.match(MAIN, /function iniciarTunnel\(porta\)/);
    assert.match(MAIN, /ipcMain\.handle\('tunnel:start', async \(_, porta\) => iniciarTunnel\(porta\)\)/);
  });

  test('e ela publica a URL nova', () => {
    const fn = MAIN.slice(MAIN.indexOf('function iniciarTunnel(porta)'),
                          MAIN.indexOf("ipcMain.handle('tunnel:start'"));
    assert.ok(fn.length > 250, `fn=${fn.length}`);
    assert.match(fn, /api\.atualizarUrlImpressao\(status\.url\)/);
  });

  test('o boot inicia o tunel junto com o servidor', () => {
    const boot = MAIN.slice(MAIN.indexOf("if (store.get('config.print_server_ativo') === true) {"),
                            MAIN.indexOf("if (store.get('config.tela_cliente_ativa') === true)"));
    assert.ok(boot.length > 400, `boot=${boot.length}`);
    assert.match(boot, /printServer\.start\(porta\)/);
    assert.match(boot, /iniciarTunnel\(porta\)/);
  });

  test('SEM await — baixar o cloudflared nao pode segurar a tela', () => {
    // No primeiro uso sao ~30MB. A tela abriria depois do download.
    const boot = MAIN.slice(MAIN.indexOf("if (store.get('config.print_server_ativo') === true) {"),
                            MAIN.indexOf("if (store.get('config.tela_cliente_ativa') === true)"));
    assert.doesNotMatch(boot, /await iniciarTunnel/);
    assert.match(boot, /\.catch\(/);
  });

  test('ligado por padrao, e desligavel', () => {
    // Quem configurou como CAIXA quer o tunel de pe — senao os outros nao
    // imprimem. Mas da para desligar sem mexer em codigo.
    assert.match(MAIN, /store\.get\('config\.tunnel_auto'\) !== false/);
    assert.match(CFG, /id="cfg-tunnel-auto"/);
    assert.match(CFG, /_onTunnelAutoToggle/);
  });

  test('so vale para quem é o servidor', () => {
    // Terminal de venda nao tem tunel a abrir.
    const boot = MAIN.slice(MAIN.indexOf("if (store.get('config.print_server_ativo') === true) {"),
                            MAIN.indexOf("if (store.get('config.tela_cliente_ativa') === true)"));
    const fora = MAIN.slice(0, MAIN.indexOf("if (store.get('config.print_server_ativo') === true) {"));
    assert.match(boot, /tunnel_auto/);
    assert.doesNotMatch(fora, /iniciarTunnel\(/);
  });
});

describe('a tela de configuracao', () => {
  test('tem a escolha do destino, com os dois caminhos', () => {
    assert.match(CFG, /id="cfg-destino-impressao"/);
    assert.match(CFG, /value="servidor">Enviar para o CAIXA/);
    assert.match(CFG, /value="local">Imprimir na impressora deste terminal/);
  });

  test('diz que vale para os tres documentos', () => {
    // Sem isso o operador testaria com a venda e suporia o resto.
    assert.match(CFG, /cupom de venda, orçamento e comprovante de entrega/);
  });

  test('carrega mostrando o que JA valia', () => {
    // A tela nao pode sugerir uma coisa e o sistema fazer outra.
    assert.match(CFG, /destinoSalvo === 'local' \|\| destinoSalvo === 'servidor'/);
    assert.match(CFG, /printIp \? 'servidor' : 'local'/);
  });

  test('salva junto com o resto da impressao', () => {
    assert.match(CFG, /config\.set\('config\.destino_impressao', destino\)/);
  });
});

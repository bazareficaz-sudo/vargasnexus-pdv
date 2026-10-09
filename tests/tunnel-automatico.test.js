const { test, describe, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { EventEmitter } = require('events');

// O TÚNEL DO CAIXA SOBE SOZINHO E NÃO FICA CAÍDO.
//
// Quick Tunnel não tem URL fixa: cada processo do cloudflared ganha uma nova.
// Enquanto ele só subia por clique em Configurações, todo reinício do caixa
// deixava os balcões sem imprimir até alguém lembrar de clicar. Estes testes
// travam o que resolve isso: subir no boot, voltar se cair, publicar cada URL
// nova, e respeitar quem desligou de propósito.

// ── Stubs de electron / electron-store ────────────────────────────────────
const gravado = {};
const carregarOriginal = Module._load;
Module._load = function (pedido, ...resto) {
  if (pedido === 'electron-store') {
    return class { get(k) { return gravado[k]; } set(k, v) { gravado[k] = v; } };
  }
  if (pedido === 'electron') return { app: { getPath: () => '/tmp' } };
  return carregarOriginal.call(this, pedido, ...resto);
};
const tunnel = require('../src/main/tunnel');
Module._load = carregarOriginal;

// ── cloudflared falso ─────────────────────────────────────────────────────
let processos;
function processoFalso() {
  const p = new EventEmitter();
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.morto = false;
  p.kill = () => { p.morto = true; setImmediate(() => p.emit('close', null)); };
  p.darUrl = (sub) => p.stderr.emit('data', Buffer.from(`INF |  https://${sub}.trycloudflare.com  |`));
  p.cair = (code = 1) => p.emit('close', code);
  processos.push(p);
  return p;
}
const tick = () => new Promise((r) => setImmediate(r));

// Relógio falso ligado uma vez só: desligar e religar entre testes perdia
// timers criados logo no começo do teste seguinte.
before(() => mock.timers.enable({ apis: ['setTimeout'] }));
after(() => mock.timers.reset());
beforeEach(() => {
  processos = [];
  tunnel._setDependencias({ spawn: () => processoFalso(), ensureBinary: async () => '/bin/cloudflared' });
});
afterEach(async () => {
  tunnel.stop();
  await tick(); // deixa o `close` do processo morto chegar antes do próximo teste
});

describe('manterAtivo', () => {
  test('sobe, resolve com a URL e avisa estado ativo', async () => {
    const estados = [];
    const p = tunnel.manterAtivo(3001, (s) => estados.push(s));
    await tick();
    processos[0].darUrl('abc-def');
    const r = await p;
    assert.equal(r.url, 'https://abc-def.trycloudflare.com');
    assert.ok(estados.some((s) => s.estado === 'ativo' && s.url === r.url));
    assert.equal(tunnel.getStatus().ativo, true);
    assert.equal(tunnel.getStatus().mantido, true);
  });

  test('se o cloudflared cair, sobe de novo e publica a URL nova', async () => {
    const urls = [];
    const p = tunnel.manterAtivo(3001, (s) => { if (s.estado === 'ativo') urls.push(s.url); });
    await tick();
    processos[0].darUrl('primeira');
    await p;

    processos[0].cair();
    assert.equal(tunnel.getStatus().ativo, false);
    assert.equal(processos.length, 1, 'não pode subir na hora: espera antes');

    mock.timers.tick(5000);
    await tick();
    assert.equal(processos.length, 2, 'deveria ter subido de novo');
    processos[1].darUrl('segunda');
    await tick();
    assert.deepEqual(urls, [
      'https://primeira.trycloudflare.com',
      'https://segunda.trycloudflare.com',
    ]);
  });

  test('falha ao subir (saiu sem URL) também tenta de novo, com espera crescente', async () => {
    const p = tunnel.manterAtivo(3001, () => {});
    await tick();
    processos[0].cair(1);
    await assert.rejects(p, /antes de gerar a URL/);

    mock.timers.tick(5000);
    await tick();
    assert.equal(processos.length, 2);
    processos[1].cair(1);
    await tick();

    mock.timers.tick(5000);
    await tick();
    assert.equal(processos.length, 2, 'segunda espera é maior que 5s');
    mock.timers.tick(10000);
    await tick();
    assert.equal(processos.length, 3);
  });

  test('sem URL em 30s: derruba o processo e tenta de novo', async () => {
    const p = tunnel.manterAtivo(3001, () => {});
    await tick();
    mock.timers.tick(30000);
    await assert.rejects(p, /Timeout/);
    assert.equal(processos[0].morto, true);
    mock.timers.tick(5000);
    await tick();
    assert.equal(processos.length, 2);
  });

  test('download do cloudflared falhando (sem internet no boot) também é retentado', async () => {
    let falhas = 1;
    tunnel._setDependencias({
      ensureBinary: async () => { if (falhas-- > 0) throw new Error('sem rede'); return '/bin/cloudflared'; },
    });
    await assert.rejects(tunnel.manterAtivo(3001, () => {}), /sem rede/);
    assert.equal(processos.length, 0);
    mock.timers.tick(5000);
    await tick();
    assert.equal(processos.length, 1);
  });
});

describe('stop', () => {
  test('desliga de vez: mata o processo e não volta mais', async () => {
    const p = tunnel.manterAtivo(3001, () => {});
    await tick();
    processos[0].darUrl('x');
    await p;
    tunnel.stop();
    await tick();
    assert.equal(processos[0].morto, true);
    mock.timers.tick(600000);
    await tick();
    assert.equal(processos.length, 1);
    assert.equal(tunnel.getStatus().mantido, false);
  });

  test('cancela a retentativa já agendada', async () => {
    const p = tunnel.manterAtivo(3001, () => {});
    await tick();
    processos[0].cair(1);
    await assert.rejects(p);
    tunnel.stop();
    mock.timers.tick(600000);
    await tick();
    assert.equal(processos.length, 1);
  });

  test('parar durante o download do cloudflared não sobe processo depois', async () => {
    let liberar;
    tunnel._setDependencias({ ensureBinary: () => new Promise((r) => { liberar = () => r('/bin/cloudflared'); }) });
    const p = tunnel.manterAtivo(3001, () => {});
    await tick();
    tunnel.stop();
    liberar();
    await assert.rejects(p, /parado/);
    assert.equal(processos.length, 0);
  });

  test('o close do processo parado não apaga o túnel novo', async () => {
    const p1 = tunnel.manterAtivo(3001, () => {});
    await tick();
    processos[0].darUrl('velho');
    await p1;
    tunnel.stop();                       // kill → close chega no próximo tick
    const p2 = tunnel.manterAtivo(3001, () => {});
    await tick();
    await tick();
    processos[1].darUrl('novo');
    const r = await p2;
    assert.equal(r.url, 'https://novo.trycloudflare.com');
    assert.equal(tunnel.getStatus().ativo, true);
  });
});

// ── Ligação no main.js (estrutural: main.js precisa do Electron inteiro) ──
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.js'), 'utf8').split(CR + LF).join(LF);

describe('main.js liga o túnel sozinho', () => {
  test('no boot, junto com o servidor de impressão, salvo se desligado de propósito', () => {
    const boot = main.slice(main.indexOf("mainWindow.once('ready-to-show'"), main.indexOf('abrirTelaCliente();'));
    assert.match(boot, /printServer\.start\(porta\)/);
    assert.match(boot, /config\.tunnel_auto'\) !== false/);
    assert.match(boot, /ligarTunnel\(porta\)/);
  });

  test('o túnel é mantido (manterAtivo) e cada URL nova é publicada', () => {
    const fn = main.slice(main.indexOf('function ligarTunnel('), main.indexOf("ipcMain.handle('tunnel:start'"));
    assert.match(fn, /tunnel\.manterAtivo\(/);
    assert.match(fn, /publicarUrlTunnel\(status\.url\)/);
  });

  test('Parar grava a preferência; Ativar religa', () => {
    assert.match(main, /'tunnel:stop'[\s\S]{0,80}config\.tunnel_auto', false/);
    assert.match(main, /'tunnel:start'[\s\S]{0,80}config\.tunnel_auto', true/);
  });

  test('o cloudflared morre junto com o PDV', () => {
    assert.match(main, /app\.on\('will-quit'[^\n]*tunnel\.stop\(\)/);
  });
});

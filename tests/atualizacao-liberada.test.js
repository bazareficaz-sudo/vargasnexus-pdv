const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const { EventEmitter } = require('events');
const { podeBaixar, compararVersao, versaoValida } = require('../src/main/atualizacaoLiberada');

// ATUALIZAÇÃO AUTOMÁTICA SÓ ATÉ O TETO LIBERADO PELO SERVIDOR.
//
// Uma Release publicada no GitHub chegava a TODOS os terminais de uma vez,
// inclusive a um de outra linhagem. O que estes testes travam: sem teto (ou
// sem resposta do servidor) o terminal não baixa nada, e com teto ele nunca
// passa dele.

describe('regra', () => {
  test('compara numericamente, não como texto', () => {
    assert.equal(compararVersao('1.10.8', '1.9.9'), 1);
    assert.equal(compararVersao('1.10.8', '1.10.8'), 0);
    assert.equal(compararVersao('1.10.8', '1.10.10'), -1);
  });

  test('baixa só o que é maior que a atual e não passa do teto', () => {
    assert.equal(podeBaixar({ atual: '1.10.8', oferecida: '1.10.9', teto: '1.10.9' }), true);
    assert.equal(podeBaixar({ atual: '1.10.8', oferecida: '1.10.9', teto: '1.11.0' }), true);
    assert.equal(podeBaixar({ atual: '1.10.8', oferecida: '1.10.10', teto: '1.10.9' }), false, 'acima do teto');
    assert.equal(podeBaixar({ atual: '1.10.8', oferecida: '1.10.8', teto: '1.10.9' }), false, 'mesma versão');
    assert.equal(podeBaixar({ atual: '1.10.8', oferecida: '1.10.7', teto: '1.10.9' }), false, 'nunca desce');
  });

  test('dado malformado é "não"', () => {
    for (const teto of [null, undefined, '', 'latest', '1.10', '1.10.9-beta']) {
      assert.equal(podeBaixar({ atual: '1.10.8', oferecida: '1.10.9', teto }), false, String(teto));
    }
    assert.equal(versaoValida(' 1.2.3 '), true);
  });
});

// ── O fluxo do updater, com electron-updater falso ───────────────────────
const falso = new EventEmitter();
falso.logger = null;
falso.checagens = 0;
falso.downloads = 0;
falso.checkForUpdates = async () => { falso.checagens++; };
falso.downloadUpdate = async () => { falso.downloads++; };
falso.quitAndInstall = () => {};

const logNulo = { info() {}, warn() {}, transports: { file: {} } };
const carregar = Module._load;
Module._load = function (pedido, ...resto) {
  if (pedido === 'electron-updater') return { autoUpdater: falso };
  if (pedido === 'electron-log') return logNulo;
  if (pedido === 'electron') return { dialog: {}, app: { getVersion: () => '1.10.8' } };
  return carregar.call(this, pedido, ...resto);
};
const updater = require('../src/main/updater');
Module._load = carregar;
// `init` não é chamado: ele agenda timers que prenderiam o processo de teste.
// O ouvinte de `update-available` é testado direto.

describe('updater', () => {
  let teto;
  beforeEach(() => {
    falso.checagens = 0;
    falso.downloads = 0;
    teto = null;
    updater._setDependencias({ versaoAtual: () => '1.10.8', perguntarTeto: async () => teto });
  });

  test('não baixa sozinho: autoDownload desligado', () => {
    assert.equal(falso.autoDownload, false);
  });

  test('servidor fora / sem identidade: nem consulta o GitHub', async () => {
    teto = { ok: false, motivo: 'rede' };
    assert.equal((await updater.verificar()).estado, 'sem_resposta');
    assert.equal(falso.checagens, 0);
  });

  test('erro ao perguntar também é "não atualiza"', async () => {
    updater._setDependencias({ perguntarTeto: async () => { throw new Error('boom'); } });
    assert.equal((await updater.verificar()).estado, 'sem_resposta');
    assert.equal(falso.checagens, 0);
  });

  test('terminal sem teto (NULL no banco): não consulta', async () => {
    teto = { ok: true, teto: null };
    assert.equal((await updater.verificar()).estado, 'nao_liberada');
    assert.equal(falso.checagens, 0);
  });

  test('já no teto: não consulta', async () => {
    teto = { ok: true, teto: '1.10.8' };
    assert.equal((await updater.verificar()).estado, 'em_dia');
    assert.equal(falso.checagens, 0);
  });

  test('liberado: consulta e baixa a Release dentro do teto', async () => {
    teto = { ok: true, teto: '1.10.9' };
    assert.equal((await updater.verificar()).estado, 'consultado');
    assert.equal(falso.checagens, 1);
    updater._aoOferecer({ version: '1.10.9' });
    assert.equal(falso.downloads, 1);
  });

  test('Release acima do teto: não baixa, espera a vez', async () => {
    teto = { ok: true, teto: '1.10.9' };
    await updater.verificar();
    updater._aoOferecer({ version: '1.10.10' });
    assert.equal(falso.downloads, 0);
  });

  test('teto retirado depois: oferta que chega não é baixada', async () => {
    teto = { ok: true, teto: '1.10.9' };
    await updater.verificar();
    teto = { ok: true, teto: null };
    await updater.verificar();
    updater._aoOferecer({ version: '1.10.9' });
    assert.equal(falso.downloads, 0);
  });
});

describe('ligação', () => {
  test('init registra o ouvinte que confere o teto', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'main', 'updater.js'), 'utf8');
    assert.match(src, /autoUpdater\.on\('update-available', aoOferecer\)/);
    assert.match(src, /autoUpdater\.autoDownload = false/);
  });
});

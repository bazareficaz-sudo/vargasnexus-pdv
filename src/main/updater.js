/**
 * updater.js — Atualização automática via GitHub Releases, LIBERADA PELO SERVIDOR
 *
 * Repositório vargasnexus-pdv é público — releases são lidos sem autenticação,
 * então nenhum token precisa ficar embutido no app distribuído.
 * Requer GH_TOKEN no ambiente só na hora de publicar (npm run publish).
 *
 * ── POR QUE O SERVIDOR DECIDE ────────────────────────────────────────────
 *
 * Até a 1.10.6 o terminal baixava qualquer Release maior que a sua. Publicar
 * uma Release entregava a versão a TODOS de uma vez — sem piloto, e inclusive
 * a um terminal de outra linhagem que não podia recebê-la (o YOGA). Por isso
 * nenhuma Release era publicada e toda instalação era manual.
 *
 * Agora o terminal pergunta GET /api/pdv/atualizacao antes de baixar, e só
 * baixa uma versão até o teto liberado para ELE em
 * pdv_terminais.atualizacao_liberada_ate. Sem resposta (offline, sem
 * identidade, rota fora do ar) ou sem teto: não baixa nada. O rollout vira
 * uma coluna no banco, terminal por terminal.
 *
 * ATENÇÃO: isto só protege terminais que JÁ rodam este código. Um terminal
 * em versão anterior continua baixando qualquer Release publicada.
 */

const { autoUpdater } = require('electron-updater');
const { dialog, app } = require('electron');
const log = require('electron-log');
const { podeBaixar, versaoValida } = require('./atualizacaoLiberada');

let mainWindowRef = null;

// Re-perguntar de tempos em tempos: liberar um terminal no banco deve valer
// sem ninguém precisar fechar e abrir o PDV.
const INTERVALO_MS = 60 * 60 * 1000;

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
// NÃO baixa sozinho: o download só começa depois de conferir o teto.
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true; // instala ao fechar o que JÁ foi baixado (e liberado)

// O teto da consulta em curso. `update-available` só baixa com ele definido.
let tetoAtual = null;
let baixando = false;

const deps = {
  versaoAtual: () => app.getVersion(),
  perguntarTeto: async () => {
    const r = await require('./terminal').chamarProtegida('/api/pdv/atualizacao', null, { metodo: 'GET' });
    if (!r.ok) return { ok: false, motivo: r.motivo };
    return { ok: true, teto: versaoValida(r.dados?.liberada_ate) ? r.dados.liberada_ate : null };
  },
};

/**
 * Pergunta o teto ao servidor e, se houver espaço para subir, procura a
 * Release. Devolve o que decidiu, para log e para o botão manual.
 */
async function verificar() {
  if (baixando) return { estado: 'baixando' };
  const atual = deps.versaoAtual();

  let resp;
  try { resp = await deps.perguntarTeto(); }
  catch (err) { resp = { ok: false, motivo: err.message }; }

  if (!resp.ok) {
    log.info(`[UPDATE] Sem resposta do servidor (${resp.motivo}) — não atualiza agora`);
    tetoAtual = null;
    return { estado: 'sem_resposta', motivo: resp.motivo };
  }
  if (!resp.teto) {
    tetoAtual = null;
    return { estado: 'nao_liberada' };
  }
  // Já está no teto (ou acima): nem consulta o GitHub.
  if (!podeBaixar({ atual, oferecida: resp.teto, teto: resp.teto })) {
    tetoAtual = null;
    return { estado: 'em_dia', teto: resp.teto };
  }

  tetoAtual = resp.teto;
  log.info(`[UPDATE] Liberado até ${resp.teto} (atual ${atual}) — consultando Releases`);
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    log.warn('[UPDATE] Falha ao checar:', err.message);
    return { estado: 'erro', mensagem: err.message };
  }
  return { estado: 'consultado', teto: resp.teto };
}

function aoOferecer(info) {
  const atual = deps.versaoAtual();
  if (!tetoAtual || !podeBaixar({ atual, oferecida: info.version, teto: tetoAtual })) {
    // Release mais nova que o liberado para este terminal: espera a vez dele.
    log.info(`[UPDATE] Release ${info.version} disponível, mas este terminal está liberado só até ${tetoAtual || '(nada)'} — não baixa`);
    return false;
  }
  log.info('[UPDATE] Disponível e liberada:', info.version);
  emitir({ evento: 'available', versao: info.version, notas: info.releaseNotes || '' });
  baixando = true;
  autoUpdater.downloadUpdate().catch((err) => {
    log.warn('[UPDATE] Falha no download:', err.message);
  }).finally(() => { baixando = false; });
  return true;
}

function init(win) {
  mainWindowRef = win;

  autoUpdater.on('checking-for-update', () => {
    emitir({ evento: 'checking' });
  });

  autoUpdater.on('update-available', aoOferecer);

  autoUpdater.on('update-not-available', () => {
    emitir({ evento: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (prog) => {
    emitir({
      evento: 'progress',
      porcentagem: Math.round(prog.percent),
      velocidade: Math.round(prog.bytesPerSecond / 1024), // KB/s
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    log.info('[UPDATE] Download completo:', info.version);
    emitir({ evento: 'downloaded', versao: info.version });
    // Notificação via dialog — usuário decide quando reiniciar
    dialog.showMessageBox(mainWindowRef, {
      type: 'info',
      title: 'Atualização pronta',
      message: `VargasNexus PDV ${info.version} foi baixado.`,
      detail: 'Clique em "Reiniciar agora" para aplicar a atualização, ou "Depois" para instalar quando fechar o app.',
      buttons: ['Reiniciar agora', 'Depois'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall(false, true);
    });
  });

  autoUpdater.on('error', (err) => {
    log.warn('[UPDATE] Erro:', err.message);
    emitir({ evento: 'error', mensagem: err.message });
  });

  // 15s após iniciar (dá tempo do app carregar e do token renovar), e depois
  // a cada hora.
  setTimeout(() => {
    verificar().catch((err) => log.warn('[UPDATE] Falha ao verificar:', err.message));
    setInterval(() => {
      verificar().catch((err) => log.warn('[UPDATE] Falha ao verificar:', err.message));
    }, INTERVALO_MS);
  }, 15000);
}

// O botão "tentar novamente" passa pela MESMA porta: liberar é do servidor.
function checarAgora() {
  return verificar().catch(err => ({ erro: err.message }));
}

function instalarAgora() {
  autoUpdater.quitAndInstall(false, true);
}

function emitir(dados) {
  try {
    if (mainWindowRef && !mainWindowRef.isDestroyed()) {
      mainWindowRef.webContents.send('update:status', dados);
    }
  } catch {}
}

function _setDependencias(novas) { Object.assign(deps, novas); }

module.exports = { init, checarAgora, instalarAgora, verificar, _aoOferecer: aoOferecer, _setDependencias };

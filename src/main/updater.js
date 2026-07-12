/**
 * updater.js — Atualização automática via GitHub Releases
 * Requer GH_TOKEN no ambiente para publicar; só lê releases públicos para checar.
 */

const { autoUpdater } = require('electron-updater');
const { dialog, shell } = require('electron');
const log = require('electron-log');

let mainWindowRef = null;

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = true;        // Baixa automaticamente em background
autoUpdater.autoInstallOnAppQuit = true; // Instala quando fechar

// Token de leitura para repositório privado no GitHub
// Permissão mínima: Contents → Read-only no repo sistemavargas
const GH_READ_TOKEN = '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';
if (GH_READ_TOKEN && GH_READ_TOKEN !== 'COLOCAR_TOKEN_AQUI') {
  autoUpdater.requestHeaders = { Authorization: `token ${GH_READ_TOKEN}` };
}

function init(win) {
  mainWindowRef = win;

  autoUpdater.on('checking-for-update', () => {
    emitir({ evento: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    log.info('[UPDATE] Disponível:', info.version);
    emitir({ evento: 'available', versao: info.version, notas: info.releaseNotes || '' });
  });

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
      message: `PDV Vargas ${info.version} foi baixado.`,
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

  // Checar 15s após iniciar (dá tempo do app carregar)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(err => {
      log.warn('[UPDATE] Falha ao checar:', err.message);
    });
  }, 15000);
}

function checarAgora() {
  return autoUpdater.checkForUpdates().catch(err => ({ erro: err.message }));
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

module.exports = { init, checarAgora, instalarAgora };

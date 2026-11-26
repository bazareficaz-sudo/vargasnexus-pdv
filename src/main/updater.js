/**
 * updater.js — Atualização automática via GitHub Releases
 * Repositório vargasnexus-pdv é público — releases são lidos sem autenticação,
 * então nenhum token precisa ficar embutido no app distribuído.
 * Requer GH_TOKEN no ambiente só na hora de publicar (npm run publish).
 */

const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

let mainWindowRef = null;

autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = true;        // Baixa automaticamente em background
autoUpdater.autoInstallOnAppQuit = true; // Instala quando fechar

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

  // INSTALA SOZINHO, NA HORA CERTA. Antes abria uma caixa "Reiniciar agora
  // / Depois": o caixa clicava em Depois para não perder o cliente da vez e
  // o terminal ficava dias na versão velha. Agora a atualização espera o
  // balcão ficar parado — carrinho vazio, nenhuma janela aberta e alguns
  // minutos sem ninguém mexer — e reinicia sozinha, em silêncio. Fechar o
  // programa também instala (autoInstallOnAppQuit). Venda que ainda não
  // subiu não se perde: a fila mora no SQLite e sobe depois de reabrir.
  autoUpdater.on('update-downloaded', (info) => {
    log.info('[UPDATE] Download completo:', info.version);
    versaoBaixada = info.version;
    emitir({ evento: 'downloaded', versao: info.version, automatico: true });
    vigiarOcioParaInstalar();
  });

  autoUpdater.on('error', (err) => {
    log.warn('[UPDATE] Erro:', err.message);
    emitir({ evento: 'error', mensagem: err.message });
  });

  // Checar 15s após iniciar (dá tempo do app carregar) e depois a cada 2h:
  // o terminal passa o dia inteiro aberto, e só checar ao abrir deixava a
  // versão nova para o dia seguinte.
  const checar = () => autoUpdater.checkForUpdates().catch(err => {
    log.warn('[UPDATE] Falha ao checar:', err.message);
  });
  setTimeout(checar, 15000);
  setInterval(() => { if (!versaoBaixada) checar(); }, INTERVALO_CHECAGEM_MS);
}

const INTERVALO_CHECAGEM_MS = 2 * 60 * 60 * 1000;
const INTERVALO_OCIO_MS = 60 * 1000;
let versaoBaixada = null;
let vigiaOcio = null;

// A cada minuto pergunta à tela se o balcão está parado
// (`window.__pdvPodeAtualizar`, em pdv.js). Sem resposta, não instala.
function vigiarOcioParaInstalar() {
  if (vigiaOcio) return;
  vigiaOcio = setInterval(async () => {
    try {
      if (!mainWindowRef || mainWindowRef.isDestroyed()) return;
      const pode = await mainWindowRef.webContents.executeJavaScript(
        'typeof window.__pdvPodeAtualizar === "function" ? window.__pdvPodeAtualizar() : false', true);
      if (pode === true) {
        clearInterval(vigiaOcio);
        vigiaOcio = null;
        log.info('[UPDATE] Balcão parado — instalando', versaoBaixada);
        autoUpdater.quitAndInstall(true, true);
      }
    } catch (e) {
      log.warn('[UPDATE] Não consegui perguntar se o balcão está parado:', e.message);
    }
  }, INTERVALO_OCIO_MS);
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

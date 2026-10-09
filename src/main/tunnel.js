/**
 * tunnel.js — Cloudflare Quick Tunnel
 * Expõe o servidor de impressão local via URL pública HTTPS.
 * Não requer conta Cloudflare — gera URL automática gratuita.
 */

const { spawn } = require('child_process');
const path   = require('path');
const fs     = require('fs');
const https  = require('https');
const Store  = require('electron-store');
const store  = new Store();

let tunnelProcess = null;
let tunnelUrl     = null;
let statusCallback = null;

function getBinaryPath() {
  // Salvar sempre em %APPDATA%\pdv-vargas\ — pasta gravável pelo usuário
  try {
    const { app } = require('electron');
    const userData = app.getPath('userData');
    return path.join(userData, 'cloudflared.exe');
  } catch {}
  // Fallback em dev
  return path.join(__dirname, '../../cloudflared.exe');
}

function downloadBinary(dest) {
  return new Promise((resolve, reject) => {
    const url = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
    const file = fs.createWriteStream(dest + '.tmp');
    const request = (u) => {
      https.get(u, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          res.resume();
          request(res.headers.location);
          return;
        }
        // Sem isto, uma página de erro do GitHub virava `cloudflared.exe` no
        // disco — e o túnel automático tentaria executá-la a cada subida.
        if (res.statusCode !== 200) {
          res.resume();
          file.close(() => fs.unlink(dest + '.tmp', () => {}));
          reject(new Error(`download do cloudflared respondeu HTTP ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            fs.renameSync(dest + '.tmp', dest);
            resolve(dest);
          });
        });
      }).on('error', (e) => { fs.unlink(dest + '.tmp', () => {}); reject(e); });
    };
    request(url);
  });
}

// Um download só, mesmo com dois pedidos ao mesmo tempo (boot + clique):
// os dois escreveriam no mesmo `.tmp`.
let downloadEmCurso = null;
async function ensureBinary() {
  const dest = getBinaryPath();
  if (fs.existsSync(dest)) return dest;
  if (statusCallback) statusCallback({ estado: 'baixando', mensagem: 'Baixando cloudflared.exe (~30MB)...' });
  if (!downloadEmCurso) {
    downloadEmCurso = downloadBinary(dest).finally(() => { downloadEmCurso = null; });
  }
  await downloadEmCurso;
  return dest;
}

// O processo e o callback de quem pediu o túnel. Guardar a referência do
// processo, e não só "tem processo", é o que impede o `close` de um túnel
// antigo (parado agora) de apagar o estado do túnel novo que já subiu.
async function start(porta = 3001, onStatus) {
  if (tunnelProcess) return { url: tunnelUrl };
  statusCallback = onStatus;
  const geracaoNoPedido = geracao;

  if (onStatus) onStatus({ estado: 'iniciando', mensagem: 'Preparando tunnel...' });

  let bin;
  try {
    bin = await deps.ensureBinary();
  } catch (err) {
    if (onStatus) onStatus({ estado: 'erro', mensagem: 'Falha ao baixar cloudflared: ' + err.message });
    throw err;
  }
  // Dois pedidos ao mesmo tempo (boot + clique) esperaram o download juntos;
  // só um sobe processo.
  if (tunnelProcess) return { url: tunnelUrl };
  // Pararam o túnel enquanto o cloudflared baixava: não sobe nada.
  if (geracao !== geracaoNoPedido) throw new Error('Tunnel parado antes de subir');

  return new Promise((resolve, reject) => {
    tunnelUrl = null;
    const proc = deps.spawn(bin, ['tunnel', '--url', `http://localhost:${porta}`], {
      windowsHide: true,
    });
    tunnelProcess = proc;
    let resolvido = false;

    const falhar = (err) => {
      if (resolvido) return;
      resolvido = true;
      clearTimeout(timeout);
      if (onStatus) onStatus({ estado: 'erro', mensagem: err.message });
      reject(err);
    };

    const timeout = setTimeout(() => {
      if (!tunnelUrl) {
        if (tunnelProcess === proc) stop({ manterDesejo: true });
        falhar(new Error('Timeout: URL não gerada em 30s'));
      }
    }, 30000);

    // cloudflared imprime a URL no stderr (algumas versões no stdout)
    const lerSaida = (data) => {
      if (tunnelProcess !== proc) return;
      const match = data.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !tunnelUrl) {
        tunnelUrl = match[0];
        ativoDesde = Date.now();
        resolvido = true;
        clearTimeout(timeout);
        store.set('config.tunnel_url', tunnelUrl);
        if (onStatus) onStatus({ estado: 'ativo', url: tunnelUrl, mensagem: `Tunnel ativo: ${tunnelUrl}` });
        resolve({ url: tunnelUrl });
      }
    };
    proc.stderr.on('data', lerSaida);
    proc.stdout.on('data', lerSaida);

    proc.on('close', (code) => {
      // Saiu antes de dar URL: falha agora, sem esperar os 30s do timeout.
      falhar(new Error(`cloudflared saiu (código ${code}) antes de gerar a URL`));
      if (tunnelProcess !== proc) return; // túnel antigo, já substituído
      const wasActive = !!tunnelUrl;
      tunnelProcess = null;
      tunnelUrl = null;
      if (onStatus) onStatus({ estado: 'parado', mensagem: wasActive ? 'Tunnel encerrado' : `cloudflared saiu (código ${code})` });
      _aoCair();
    });

    proc.on('error', (err) => {
      falhar(err);
      if (tunnelProcess !== proc) return;
      tunnelProcess = null;
      tunnelUrl = null;
      _aoCair();
    });

    if (onStatus) onStatus({ estado: 'aguardando', mensagem: 'Conectando ao Cloudflare...' });
  });
}

// ─── Manter ativo ─────────────────────────────────────────────────────────
//
// O terminal-caixa é quem recebe as impressões dos balcões pela URL do túnel.
// Quick Tunnel não tem URL fixa: cada processo do cloudflared ganha uma nova,
// e ela morre com o processo. Antes, o túnel só subia por clique em
// Configurações — o caixa reiniciava, a URL publicada apontava para o nada, e
// os balcões ficavam sem imprimir até alguém lembrar de clicar.
//
// `manterAtivo` registra o DESEJO de ter túnel e cuida dele: sobe agora, e se
// o cloudflared cair (rede, Windows suspendendo, processo morto) ou nem
// conseguir subir, tenta de novo com espera crescente. Cada subida gera URL
// nova e passa pelo `onStatus` com estado 'ativo' — é ali que quem chamou
// publica a URL. Só `stop()` desliga o desejo.
const ESPERAS_MS = [5000, 15000, 30000, 60000, 120000, 300000];
let desejo = null;        // { porta, onStatus } enquanto o túnel deve existir
let geracao = 0;          // muda a cada stop() de fora: cancela subida em curso
let tentativas = 0;
let timerRetentativa = null;

function manterAtivo(porta = 3001, onStatus) {
  desejo = { porta, onStatus };
  if (timerRetentativa) { clearTimeout(timerRetentativa); timerRetentativa = null; }
  return _subir();
}

function _subir() {
  if (!desejo) return Promise.resolve({ url: null });
  const { porta, onStatus } = desejo;
  const minhaGeracao = geracao;
  return start(porta, onStatus).catch((err) => {
    // `_aoCair` já agendou a próxima quando o processo chegou a existir; aqui
    // cobre a falha antes dele (download do cloudflared sem internet). Falha
    // de um túnel que já foi parado não agenda nada para o túnel de agora.
    if (geracao === minhaGeracao) _agendarRetentativa();
    throw err;
  });
}

// A espera só volta ao início se o túnel tinha ficado de pé por um tempo.
// Um cloudflared que sobe e cai em seguida, em laço, não pode virar uma
// criação de túnel a cada 5s — o trycloudflare limita isso.
const ESTAVEL_MS = 60000;
let ativoDesde = null;

function _aoCair() {
  if (ativoDesde && Date.now() - ativoDesde >= ESTAVEL_MS) tentativas = 0;
  ativoDesde = null;
  _agendarRetentativa();
}

function _agendarRetentativa() {
  if (!desejo || timerRetentativa || tunnelProcess) return;
  const espera = ESPERAS_MS[Math.min(tentativas, ESPERAS_MS.length - 1)];
  tentativas++;
  const cb = desejo.onStatus;
  if (cb) cb({ estado: 'aguardando', mensagem: `Tunnel caiu — tentando de novo em ${Math.round(espera / 1000)}s...` });
  timerRetentativa = setTimeout(() => {
    timerRetentativa = null;
    _subir().catch(() => {});
  }, espera);
}

// `manterDesejo` é uso interno (timeout de subida): derruba o processo mas
// deixa a retentativa agir. Quem chama de fora quer o túnel desligado de vez.
function stop({ manterDesejo = false } = {}) {
  if (!manterDesejo) {
    desejo = null;
    geracao++;
    tentativas = 0;
    if (timerRetentativa) { clearTimeout(timerRetentativa); timerRetentativa = null; }
  }
  if (tunnelProcess) {
    const proc = tunnelProcess;
    tunnelProcess = null;
    tunnelUrl = null;
    ativoDesde = null;
    proc.kill();
  }
}

function getStatus() {
  return {
    ativo: !!tunnelProcess,
    url: tunnelUrl || store.get('config.tunnel_url') || null,
    mantido: !!desejo,
  };
}

// Injeção para os testes — em produção é sempre o spawn real e o download.
const deps = { spawn, ensureBinary: () => ensureBinary() };
function _setDependencias(novas) { Object.assign(deps, novas); }

module.exports = { start, manterAtivo, stop, getStatus, getBinaryPath, _setDependencias };

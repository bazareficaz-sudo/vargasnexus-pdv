/**
 * terminal.js — a identidade deste terminal perante o servidor.
 *
 * ── O PROBLEMA QUE ISTO RESOLVE ─────────────────────────────────────────
 *
 * Hoje o PDV se identifica assim:
 *
 *     terminal_id = store.get('config.terminal_id')        → texto num JSON local
 *     empresa_id  = store.get('auth.usuario').empresa_id   → idem
 *
 * Os dois ficam em %APPDATA%\pdv-vargas\config.json, em texto puro, e quem
 * abrir o arquivo no bloco de notas troca a empresa do terminal. A chave que
 * fala com o banco é a `anon`, embutida no instalador: idêntica em todos os
 * terminais e recuperável de qualquer cópia do programa. Ou seja: hoje é o
 * CLIENTE que escolhe de que empresa ele é.
 *
 * Depois desta etapa existe um segundo caminho, em que o SERVIDOR escolhe:
 *
 *     código de ativação (uso único, 15 min, emitido no painel)
 *       → o terminal gera um segredo de 256 bits e o apresenta uma vez
 *       → o servidor guarda só o hash e devolve um token assinado
 *       → a empresa vem da linha do terminal no banco, nunca do pedido
 *
 * ── O QUE ESTA ETAPA *NÃO* FAZ ──────────────────────────────────────────
 *
 * Nada no caixa. Nenhuma venda passa por aqui. Um terminal que atualizar e
 * nunca for ativado continua vendendo exatamente como antes, pelo caminho
 * `anon` de sempre — este módulo só é chamado pela tela de configurações e
 * pela renovação em segundo plano, e falhar em qualquer um dos dois não
 * interrompe operação nenhuma. Mover as escritas para trás do token é a
 * etapa seguinte, e só depois que o painel mostrar todo mundo ativado.
 *
 * ── ONDE FICA O SEGREDO ─────────────────────────────────────────────────
 *
 * NÃO no electron-store. O `config:getAll` devolve a store inteira para o
 * renderer; um segredo lá dentro estaria a um DevTools de distância, além de
 * ficar em texto puro no disco. Ele vai para um arquivo próprio, cifrado com
 * `safeStorage` (DPAPI no Windows), fora do alcance do renderer.
 *
 * Se a plataforma não tiver cifragem disponível, a ativação é RECUSADA em vez
 * de gravar a credencial em claro. Isso não bloqueia ninguém: o terminal
 * segue no modo antigo, que é onde ele já estava.
 */

const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const Store = require('electron-store');

const store = new Store();

/** Onde ficam as rotas de identidade. O padrão é a produção. */
function baseUrl() {
  return String(store.get('config.web_url') || 'https://sistemavargas.com.br').replace(/\/+$/, '');
}

function arquivoSegredo()   { return path.join(app.getPath('userData'), 'terminal-identidade.bin'); }
function arquivoMetadados() { return path.join(app.getPath('userData'), 'terminal-identidade.json'); }

// ─── Disco ────────────────────────────────────────────────────────────────

function lerMetadados() {
  try { return JSON.parse(fs.readFileSync(arquivoMetadados(), 'utf8')); }
  catch { return null; }
}

function gravarMetadados(meta) {
  fs.writeFileSync(arquivoMetadados(), JSON.stringify(meta, null, 2), 'utf8');
}

function cifragemDisponivel() {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

function lerSegredo() {
  try {
    if (!cifragemDisponivel()) return null;
    return safeStorage.decryptString(fs.readFileSync(arquivoSegredo()));
  } catch { return null; }
}

function gravarSegredo(segredo) {
  // Sem cifragem, não grava. Ver o cabeçalho: um segredo em texto puro no
  // disco não seria melhor do que a chave `anon` que já está lá — seria só
  // mais uma.
  if (!cifragemDisponivel()) {
    throw new Error('Este computador não oferece armazenamento seguro. O terminal continua no modo antigo.');
  }
  fs.writeFileSync(arquivoSegredo(), safeStorage.encryptString(segredo));
}

function apagarArquivos() {
  for (const f of [arquivoSegredo(), arquivoMetadados()]) {
    try { fs.unlinkSync(f); } catch { /* já não existia */ }
  }
}

// ─── Telemetria (informativa, nunca autorização) ──────────────────────────

// Hostname e sistema operacional são forjáveis, e o servidor sabe disso. Eles
// existem para o painel poder dizer "este é o do balcão" — não entram em
// decisão nenhuma.
function dispositivo() {
  let usuarioSo = null;
  try { usuarioSo = os.userInfo().username; } catch { /* sem permissão, tudo bem */ }
  return {
    hostname: os.hostname(),
    plataforma: `${os.platform()} ${os.release()}`,
    usuario_so: usuarioSo,
  };
}

async function postar(rota, corpo) {
  const res = await fetch(`${baseUrl()}${rota}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  const texto = await res.text();
  let json;
  try { json = JSON.parse(texto); }
  catch { throw new Error(`Resposta inesperada do servidor (HTTP ${res.status})`); }
  if (!res.ok || !json.ok) throw new Error(json.erro || `HTTP ${res.status}`);
  return json;
}

// ─── Token ────────────────────────────────────────────────────────────────

// Em memória, e só. Persistir o token daria a quem lê o disco uma janela de
// 12 horas de graça; obtê-lo de novo custa uma requisição.
let tokenAtual = null;
let tokenExpiraEm = 0;
let ultimoErro = null;

function guardarToken(token) {
  tokenAtual = token;
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    tokenExpiraEm = (claims.exp || 0) * 1000;
  } catch { tokenExpiraEm = 0; }
}

// ─── Ativação ─────────────────────────────────────────────────────────────

/**
 * Troca um código de ativação por uma credencial permanente deste terminal.
 *
 * O SEGREDO É GERADO AQUI, antes da chamada, e não pelo servidor. Parece
 * detalhe e é o que torna a ativação repetível: se a resposta se perder no
 * caminho, o terminal ainda tem o segredo em mãos e pode repetir a chamada —
 * o servidor reconhece a MESMA ativação em vez de responder "código já
 * usado" e deixar o terminal travado esperando um código novo.
 */
async function ativar(codigo) {
  if (!codigo || !String(codigo).trim()) {
    return { ok: false, erro: 'Digite o código de ativação.' };
  }
  if (!cifragemDisponivel()) {
    return { ok: false, erro: 'Este computador não oferece armazenamento seguro. O terminal continua no modo antigo.' };
  }

  // Um segredo já gravado é reaproveitado: é exatamente o caso do retry.
  const segredo = lerSegredo() || crypto.randomBytes(32).toString('hex');

  try {
    const r = await postar('/api/pdv/auth/ativar', {
      codigo: String(codigo).trim(),
      secret: segredo,
      versao_pdv: app.getVersion(),
      terminal_id_legado: store.get('config.terminal_id') || null,
      dispositivo: dispositivo(),
    });

    gravarSegredo(segredo);
    gravarMetadados({
      terminal_id: r.terminal.id,
      terminal_nome: r.terminal.nome,
      empresa_id: r.empresa.id,
      empresa_nome: r.empresa.nome,
      ativado_em: new Date().toISOString(),
    });

    guardarToken(r.token);
    ultimoErro = null;
    console.log(`[TERMINAL] Ativado como "${r.terminal.nome}" (${r.empresa.nome})`);
    return { ok: true, ja_ativado: !!r.ja_ativado, terminal: r.terminal, empresa: r.empresa };
  } catch (err) {
    console.warn('[TERMINAL] Ativação recusada:', err.message);
    return { ok: false, erro: err.message };
  }
}

const MARGEM_RENOVACAO_MS = 30 * 60 * 1000; // renova 30 min antes de vencer

/**
 * Devolve um token válido, renovando se necessário. `null` quando o terminal
 * não está ativado — e quem chamar precisa continuar funcionando com `null`,
 * porque é o estado de todo terminal que ainda não passou pela ativação.
 */
async function obterToken({ forcar = false } = {}) {
  const meta = lerMetadados();
  const segredo = lerSegredo();
  if (!meta?.terminal_id || !segredo) return null;

  if (!forcar && tokenAtual && Date.now() < tokenExpiraEm - MARGEM_RENOVACAO_MS) {
    return tokenAtual;
  }

  try {
    const r = await postar('/api/pdv/auth/token', {
      terminal_id: meta.terminal_id,
      secret: segredo,
      versao_pdv: app.getVersion(),
    });
    guardarToken(r.token);
    ultimoErro = null;
    return tokenAtual;
  } catch (err) {
    ultimoErro = err.message;
    console.warn('[TERMINAL] Falha ao renovar token:', err.message);
    // Sem internet, o token em memória ainda vale até a hora dele. Devolver o
    // que se tem é melhor do que devolver nada — e quem chama já sabe lidar
    // com nada.
    return (tokenAtual && Date.now() < tokenExpiraEm) ? tokenAtual : null;
  }
}

// ─── Chamada autenticada ──────────────────────────────────────────────────

/**
 * Chama uma rota protegida com o token deste terminal.
 *
 * Devolve `{ ok, dados }` no sucesso e `{ ok: false, motivo, erro }` na
 * recusa. O `motivo` é o que interessa a quem chama, porque nem toda recusa é
 * um problema:
 *
 *   sem_identidade  → este terminal não foi ativado. Normal. Use o legado.
 *   rota_desligada  → a rota nova ainda não foi ligada para ele. Normal.
 *   token_expirado  → renova e repete, uma vez.
 *   qualquer_outro  → é problema, e precisa aparecer no log.
 *
 * A distinção importa: tratar "ainda não foi minha vez" como erro encheria o
 * log de alarme falso justamente durante o rollout, que é quando alguém
 * precisa conseguir enxergar o alarme verdadeiro.
 */
async function chamarProtegida(rota, corpo, { jaRenovou = false } = {}) {
  const token = await obterToken();
  if (!token) return { ok: false, motivo: 'sem_identidade', erro: 'Terminal não ativado' };

  let res;
  try {
    res = await fetch(`${baseUrl()}${rota}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // No cabeçalho, nunca na URL: token em query string vaza por log de
        // acesso, histórico e Referer.
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(corpo),
    });
  } catch (err) {
    return { ok: false, motivo: 'rede', erro: err.message };
  }

  const texto = await res.text();
  let json;
  try { json = JSON.parse(texto); }
  catch { return { ok: false, motivo: 'resposta_invalida', erro: `HTTP ${res.status}` }; }

  if (json.ok) return { ok: true, dados: json };

  // Token vencido no meio do caminho: renova UMA vez e repete. Sem o limite,
  // um servidor que recuse por outro motivo viraria laço infinito.
  if (json.motivo === 'token_expirado' && !jaRenovou) {
    await obterToken({ forcar: true });
    return chamarProtegida(rota, corpo, { jaRenovou: true });
  }

  return { ok: false, motivo: json.motivo || 'recusado', erro: json.erro || `HTTP ${res.status}` };
}

/** Chave de idempotência estável para a MESMA intenção. */
function chaveDe(prefixo, conteudo) {
  const h = crypto.createHash('sha256').update(String(conteudo)).digest('hex').slice(0, 32);
  return `${prefixo}:${h}`;
}

// ─── Estado, para a tela de configurações ─────────────────────────────────

function estado() {
  const meta = lerMetadados();
  return {
    ativado: !!(meta?.terminal_id && lerSegredo()),
    terminal_id: meta?.terminal_id || null,
    terminal_nome: meta?.terminal_nome || null,
    empresa_nome: meta?.empresa_nome || null,
    ativado_em: meta?.ativado_em || null,
    token_valido: !!(tokenAtual && Date.now() < tokenExpiraEm),
    token_expira_em: tokenExpiraEm ? new Date(tokenExpiraEm).toISOString() : null,
    cifragem_disponivel: cifragemDisponivel(),
    terminal_id_legado: store.get('config.terminal_id') || null,
    versao: app.getVersion(),
    ultimo_erro: ultimoErro,
  };
}

/**
 * Esquece a identidade local. NÃO revoga nada no servidor — revogar é ato do
 * painel, feito por quem tem permissão. Isto aqui existe para reinstalação ou
 * para terminal que trocou de dono: desativa a máquina, e a linha no painel
 * continua lá para ser revogada por quem deve.
 */
function esquecer() {
  apagarArquivos();
  tokenAtual = null;
  tokenExpiraEm = 0;
  ultimoErro = null;
  console.log('[TERMINAL] Identidade local apagada. O terminal voltou ao modo antigo.');
  return { ok: true };
}

// ─── Renovação em segundo plano ───────────────────────────────────────────

/**
 * Mantém o token fresco e o "visto por último" do painel atualizado.
 *
 * É deliberadamente inofensiva: se o terminal não está ativado ela não faz
 * nada, e se a rede cair ela erra em silêncio no log. A telemetria que ela
 * alimenta é o que decide quando a etapa seguinte pode acontecer — sem ela o
 * painel não teria como distinguir "ativado" de "ativado e vivo".
 */
function iniciarRenovacao() {
  const tentar = () => { obterToken().catch(() => {}); };
  setTimeout(tentar, 20_000);            // depois da carga inicial do PDV
  setInterval(tentar, 60 * 60 * 1000);   // de hora em hora
}

module.exports = {
  ativar, obterToken, estado, esquecer, iniciarRenovacao,
  chamarProtegida, chaveDe,
};

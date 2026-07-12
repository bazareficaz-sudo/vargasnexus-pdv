/**
 * print-server.js — Servidor de impressão local em rede
 *
 * CAIXA: inicia servidor HTTP na porta configurada, recebe jobs e imprime localmente.
 * Terminais de venda: POST /imprimir para o IP do CAIXA.
 */

const http = require('http');
const { BrowserWindow } = require('electron');
const Store = require('electron-store');
const fetch = require('node-fetch');

const store = new Store();

let server = null;
const fila = [];
let imprimindo = false;

// ─── Geração do HTML do cupom ────────────────────────────────────────────────

// Configurações por layout
const LAYOUTS = {
  // Compacto: fonte menor, ideal para 58mm ou quem quer economizar papel
  compacto: { largura: '72mm', fonteBase: '8pt', fonteSm: '7pt', fonteLg: '11pt', fonteTotal: '11pt', margem: '3mm 2mm' },
  // Padrão: equilibrado, 72mm
  padrao:   { largura: '72mm', fonteBase: '9.5pt', fonteSm: '8pt', fonteLg: '13pt', fonteTotal: '12pt', margem: '4mm 3mm' },
  // Grande: fonte maior, mais fácil de ler
  grande:   { largura: '72mm', fonteBase: '12pt', fonteSm: '10pt', fonteLg: '16pt', fonteTotal: '15pt', margem: '4mm 3mm' },
};

function gerarHtmlCupom(dados) {
  const { numero, empresa_nome, vendedor_nome, cliente_nome, itens = [],
          subtotal = 0, desconto = 0, total = 0, forma_pagamento = '',
          valor_pago = 0, troco = 0, created_at } = dados;

  const layoutNome = store.get('config.cupom_layout') || 'padrao';
  const L = LAYOUTS[layoutNome] || LAYOUTS.padrao;

  const fmt = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const data = created_at ? new Date(created_at).toLocaleString('pt-BR') : new Date().toLocaleString('pt-BR');

  const linhas = itens.map(i => {
    const qtd = Number(i.quantidade || 0);
    const preco = Number(i.preco_unitario || 0);
    const sub = Number(i.subtotal || i.total || 0);
    return `
      <tr>
        <td colspan="2" style="padding-top:5px;font-weight:bold">${i.produto_nome}</td>
      </tr>
      <tr>
        <td style="color:#555">${Math.abs(qtd)} x R$ ${fmt(preco)}</td>
        <td style="text-align:right;font-weight:bold">R$ ${fmt(Math.abs(sub))}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @page { size: ${L.largura} auto; margin: ${L.margem}; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Courier New', Courier, monospace;
    font-size: ${L.fonteBase};
    color: #000;
    background: #fff;
    width: ${L.largura};
    margin: 0; padding: 0;
  }
  .center { text-align: center; }
  .right  { text-align: right; }
  .bold   { font-weight: bold; }
  .sm     { font-size: ${L.fonteSm}; }
  .lg     { font-size: ${L.fonteLg}; }
  .sep    { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  table   { width: 100%; border-collapse: collapse; }
  td      { vertical-align: top; padding: 1px 0; }
  .total-row td { font-size: ${L.fonteTotal}; font-weight: bold; padding-top: 6px; }
</style>
</head>
<body>
  <div class="center bold lg">${empresa_nome || 'PDV VARGAS'}</div>
  <div class="center sm">Venda #${numero}</div>
  <div class="center sm">${data}</div>
  ${vendedor_nome ? `<div class="center sm">Vendedor: ${vendedor_nome}</div>` : ''}
  ${cliente_nome  ? `<div class="center sm">Cliente: ${cliente_nome}</div>`   : ''}
  <hr class="sep">

  <table>${linhas}</table>
  <hr class="sep">

  ${desconto > 0 ? `
  <table><tr>
    <td>Subtotal</td><td class="right">R$ ${fmt(subtotal)}</td>
  </tr><tr>
    <td>Desconto</td><td class="right">- R$ ${fmt(desconto)}</td>
  </tr></table>` : ''}

  <table class="total-row"><tr>
    <td>TOTAL</td><td class="right">R$ ${fmt(Math.abs(total))}</td>
  </tr></table>

  <div style="margin-top:6px;font-size:${L.fonteSm}">
    Pagamento: <strong>${(forma_pagamento || '').toUpperCase()}</strong>
    ${valor_pago > 0 ? `<br>Recebido: R$ ${fmt(valor_pago)}` : ''}
    ${troco > 0     ? `<br>Troco: R$ ${fmt(troco)}`         : ''}
  </div>

  <hr class="sep">
  <div class="center sm" style="margin-top:4px">Obrigado pela preferencia!</div>
</body>
</html>`;
}

// ─── Cupom de Entrega ────────────────────────────────────────────────────────

function gerarHtmlCupomEntrega(dados) {
  const {
    empresa_nome = 'PDV VARGAS',
    cliente_nome, cliente_telefone, cliente_doc,
    logradouro, numero, complemento, bairro, cidade, estado, cep,
    referencia, obs,
    data_entrega, turno,
    itens = [],
    total_entrega = 0,
    numero_venda,
    emitido_em,
  } = dados;

  const fmt = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const agora = emitido_em ? new Date(emitido_em).toLocaleString('pt-BR') : new Date().toLocaleString('pt-BR');

  const turnoLabel = { manha: 'Manhã', tarde: 'Tarde', noite: 'Noite', qualquer: 'Qualquer período' }[turno] || turno || '';

  const dataFmt = data_entrega
    ? new Date(data_entrega + 'T12:00:00').toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' })
    : '—';

  const enderecoLinha1 = [logradouro, numero].filter(Boolean).join(', ');
  const enderecoLinha2 = [complemento, bairro].filter(Boolean).join(' — ');
  const enderecoLinha3 = [cidade, estado, cep].filter(Boolean).join(' - ');

  const linhasItens = itens.map(i => `
    <tr>
      <td colspan="2" style="padding-top:5px;font-weight:bold">${i.produto_nome}</td>
    </tr>
    <tr>
      <td style="color:#555">${Math.abs(i.quantidade || 1)} un</td>
      <td style="text-align:right">R$ ${fmt(Math.abs(i.total || 0))}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  @page { size: 72mm auto; margin: 4mm 3mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Courier New', Courier, monospace;
    font-size: 9.5pt;
    color: #000;
    background: #fff;
    width: 72mm;
    margin: 0;
    padding: 0;
  }
  .center { text-align: center; }
  .right  { text-align: right; }
  .bold   { font-weight: bold; }
  .sm     { font-size: 8pt; }
  .lg     { font-size: 13pt; }
  .xl     { font-size: 15pt; }
  .sep    { border: none; border-top: 1px dashed #000; margin: 6px 0; }
  .sep2   { border: none; border-top: 2px solid #000; margin: 6px 0; }
  table   { width: 100%; border-collapse: collapse; }
  td      { vertical-align: top; padding: 1px 0; }
  .bloco  { margin-bottom: 8px; }
  .label  { font-size: 7.5pt; color: #555; text-transform: uppercase; margin-bottom: 1px; }
  .val    { font-size: 9.5pt; }
  .agenda-box {
    border: 2px solid #000;
    border-radius: 2px;
    padding: 6px 8px;
    margin: 8px 0;
    text-align: center;
  }
</style>
</head>
<body>

  <div class="center bold lg">${empresa_nome}</div>
  <div class="center bold" style="font-size:11pt;letter-spacing:1px;margin-top:2px">COMPROVANTE DE ENTREGA</div>
  <div class="center sm">${agora}</div>
  ${numero_venda ? `<div class="center sm">Pedido #${numero_venda}</div>` : ''}

  <hr class="sep2">

  <div class="bloco">
    <div class="label">Cliente</div>
    <div class="val bold">${cliente_nome || '—'}</div>
    ${cliente_telefone ? `<div class="val">Tel: ${cliente_telefone}</div>` : ''}
    ${cliente_doc ? `<div class="val sm">Doc: ${cliente_doc}</div>` : ''}
  </div>

  <hr class="sep">

  <div class="bloco">
    <div class="label">Endereco de Entrega</div>
    <div class="val bold">${enderecoLinha1 || '—'}</div>
    ${enderecoLinha2 ? `<div class="val">${enderecoLinha2}</div>` : ''}
    ${enderecoLinha3 ? `<div class="val">${enderecoLinha3}</div>` : ''}
  </div>

  ${referencia ? `
  <div class="bloco">
    <div class="label">Ponto de Referencia</div>
    <div class="val">${referencia}</div>
  </div>` : ''}

  ${obs ? `
  <div class="bloco">
    <div class="label">Observacao / Instrucao</div>
    <div class="val sm">${obs}</div>
  </div>` : ''}

  <div class="agenda-box">
    <div class="label" style="color:#000">Agendamento</div>
    <div class="bold xl">${dataFmt}</div>
    ${turnoLabel ? `<div class="bold" style="margin-top:3px;font-size:11pt">Periodo: ${turnoLabel}</div>` : ''}
  </div>

  <hr class="sep">

  <div class="label">Itens para Entrega</div>
  <table>${linhasItens}</table>
  <hr class="sep">

  <table>
    <tr>
      <td class="bold" style="font-size:11pt">TOTAL ENTREGA</td>
      <td class="right bold" style="font-size:11pt">R$ ${fmt(total_entrega)}</td>
    </tr>
  </table>

  <hr class="sep">
  <div class="center sm" style="margin-top:6px">Obrigado pela preferencia!</div>
  <div class="center sm" style="margin-top:2px">_____________________________</div>
  <div class="center sm" style="margin-top:2px">Assinatura do Entregador</div>
  <div class="center sm" style="margin-top:10px">_____________________________</div>
  <div class="center sm" style="margin-top:2px">Assinatura / Ciencia do Cliente</div>
  <br><br>
</body>
</html>`;
}

// ─── Impressão local (via Electron) ─────────────────────────────────────────

async function imprimirLocal(dados) {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 320,
      height: 800,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    const html = dados._html || gerarHtmlCupom(dados);
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    win.webContents.once('did-finish-load', () => {
      const nomePrinter = store.get('config.impressora_nome') || '';
      const opts = {
        silent: true,
        printBackground: false,
        color: false,
        margins: { marginType: 'none' },
        pageSize: { width: 72000, height: 999000 }, // microns — 72mm × comprimento auto
        scaleFactor: 100,
      };
      if (nomePrinter) opts.deviceName = nomePrinter;

      win.webContents.print(opts, (success, failureReason) => {
        win.destroy();
        if (success) {
          console.log('[PRINT] Impresso com sucesso');
        } else {
          console.warn('[PRINT] Falha:', failureReason);
        }
        resolve({ success, failureReason: failureReason || null });
      });
    });

    win.webContents.once('did-fail-load', (_, code, desc) => {
      win.destroy();
      resolve({ success: false, failureReason: desc });
    });
  });
}

// ─── Fila de impressão ───────────────────────────────────────────────────────

async function processarFila() {
  if (imprimindo || fila.length === 0) return;
  imprimindo = true;
  const job = fila.shift();
  try {
    await imprimirLocal(job);
  } catch (e) {
    console.warn('[PRINT] Erro no job:', e.message);
  }
  imprimindo = false;
  if (fila.length > 0) setImmediate(processarFila);
}

function adicionarNaFila(dados) {
  fila.push(dados);
  processarFila();
}

// ─── Servidor HTTP (modo CAIXA) ──────────────────────────────────────────────

function start(port) {
  if (server) return { ok: true, ja_rodando: true };
  port = port || store.get('config.print_server_porta') || 3001;

  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, fila: fila.length, imprimindo }));
      return;
    }

    if (req.method === 'POST' && req.url === '/imprimir') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const dados = JSON.parse(body);
          adicionarNaFila(dados);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, posicao_fila: fila.length }));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ erro: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ erro: 'Rota não encontrada' }));
  });

  server.on('error', (err) => {
    console.error('[PRINT SERVER] Erro ao iniciar:', err.message);
    server = null;
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[PRINT SERVER] Ativo em 0.0.0.0:${port}`);
  });

  return { ok: true, porta: port };
}

function stop() {
  if (!server) return;
  server.close(() => console.log('[PRINT SERVER] Encerrado'));
  server = null;
}

function isRunning() { return !!server; }

// ─── Envio para servidor remoto (terminais de venda) ─────────────────────────

async function enviarParaServidor(dados) {
  const ip = store.get('config.print_server_ip') || '';
  if (!ip) throw new Error('IP do servidor de impressão não configurado');
  // Aceita URL completa (tunnel Cloudflare) ou IP:porta local
  const url = ip.startsWith('http://') || ip.startsWith('https://')
    ? ip.replace(/\/$/, '') + '/imprimir'
    : `http://${ip}/imprimir`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dados),
    timeout: 6000,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Servidor retornou ${res.status}: ${txt}`);
  }
  return res.json();
}

async function listarImpressoras(win) {
  if (!win) return [];
  try {
    const lista = await win.webContents.getPrintersAsync();
    return lista.map(p => ({ name: p.name, descricao: p.description || p.name, padrao: p.isDefault }));
  } catch {
    return [];
  }
}

// ─── HTML A4 para orçamento (diálogo de impressão do Windows) ───────────────

function gerarHtmlOrcamento(dados) {
  const { numero, empresa_nome = '', vendedor_nome = '', cliente_nome = '',
          cliente_telefone = '', forma_pagamento = '', validade_dias = 7,
          subtotal = 0, desconto = 0, total = 0, observacao = '',
          itens = [], created_at } = dados;

  const fmt   = v => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const data  = created_at ? new Date(created_at).toLocaleDateString('pt-BR') : new Date().toLocaleDateString('pt-BR');
  const venc  = (() => {
    const d = created_at ? new Date(created_at) : new Date();
    d.setDate(d.getDate() + (validade_dias || 7));
    return d.toLocaleDateString('pt-BR');
  })();
  const formaMap = { dinheiro:'Dinheiro', pix:'PIX', credito:'Cartão de Crédito',
    debito:'Cartão de Débito', boleto:'Boleto', outros:'A Combinar', carteira:'Crédito Loja' };
  const formaTxt = formaMap[forma_pagamento] || forma_pagamento || '—';
  const descItens = itens.reduce((s, i) => s + (Number(i.desconto) || 0), 0);

  const linhasItens = itens.map((i, idx) => `
    <tr class="${idx % 2 === 0 ? 'par' : ''}">
      <td>${i.produto_nome || ''}</td>
      <td class="c">${Number(i.quantidade)}</td>
      <td class="r">R$ ${fmt(i.preco_unitario)}</td>
      <td class="r" style="color:#c0392b">${Number(i.desconto) > 0 ? '− R$ ' + fmt(i.desconto) : '—'}</td>
      <td class="r fw">R$ ${fmt(i.total)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; font-size: 11pt; color: #222; padding: 20mm 18mm; }
  h1 { font-size: 22pt; color: #2c7a4b; margin-bottom: 2px; }
  .empresa { font-size: 13pt; font-weight: bold; color: #333; }
  .subtitulo { font-size: 9pt; color: #777; margin-bottom: 14px; }
  hr { border: none; border-top: 1.5px solid #ddd; margin: 12px 0; }
  hr.thick { border-top: 2.5px solid #2c7a4b; }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
  .bloco { background: #f7f7f7; border-radius: 6px; padding: 10px 14px; }
  .bloco .label { font-size: 8pt; text-transform: uppercase; letter-spacing: .5px; color: #888; margin-bottom: 3px; }
  .bloco .val { font-size: 11pt; font-weight: bold; }
  .bloco .sub { font-size: 9pt; color: #666; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  thead tr { background: #2c7a4b; color: #fff; }
  thead th { padding: 7px 10px; font-size: 9pt; text-align: left; }
  th.c, td.c { text-align: center; }
  th.r, td.r { text-align: right; }
  td { padding: 6px 10px; font-size: 10pt; border-bottom: 1px solid #eee; }
  tr.par td { background: #fafafa; }
  .fw { font-weight: bold; }
  .totals { margin-top: 12px; }
  .totals table { width: 260px; margin-left: auto; }
  .totals td { border: none; padding: 3px 6px; font-size: 10.5pt; }
  .totals .total-row td { font-size: 14pt; font-weight: bold; color: #2c7a4b; border-top: 2px solid #2c7a4b; padding-top: 6px; }
  .obs { background: #fffbe6; border: 1px solid #f0d060; border-radius: 6px; padding: 10px 14px; font-size: 10pt; color: #555; margin-top: 14px; }
  .rodape { margin-top: 20px; text-align: center; font-size: 8.5pt; color: #999; border-top: 1px solid #ddd; padding-top: 10px; }
  @media print { body { padding: 10mm; } }
</style>
</head>
<body>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px">
    <div>
      <div class="empresa">${empresa_nome}</div>
      <h1>ORÇAMENTO #${numero}</h1>
      <div class="subtitulo">Emitido em ${data} · Válido até ${venc} · Vendedor: ${vendedor_nome || '—'}</div>
    </div>
  </div>

  <hr class="thick">

  <div class="grid2">
    <div class="bloco">
      <div class="label">Cliente</div>
      <div class="val">${cliente_nome || 'Sem cliente'}</div>
      ${cliente_telefone ? `<div class="sub">${cliente_telefone}</div>` : ''}
    </div>
    <div class="bloco">
      <div class="label">Forma de Pagamento</div>
      <div class="val">${formaTxt}</div>
      <div class="sub">Validade: ${venc}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>Produto</th>
        <th class="c">Qtd</th>
        <th class="r">Unit.</th>
        <th class="r">Desconto</th>
        <th class="r">Total</th>
      </tr>
    </thead>
    <tbody>${linhasItens}</tbody>
  </table>

  <div class="totals">
    <table>
      ${descItens > 0 ? `<tr><td>Desconto em itens</td><td class="r" style="color:#c0392b">− R$ ${fmt(descItens)}</td></tr>` : ''}
      ${Number(desconto) > 0 ? `<tr><td>Desconto geral</td><td class="r" style="color:#c0392b">− R$ ${fmt(desconto)}</td></tr>` : ''}
      <tr class="total-row"><td>TOTAL</td><td class="r">R$ ${fmt(total)}</td></tr>
    </table>
  </div>

  ${observacao ? `<div class="obs">📝 ${observacao}</div>` : ''}

  <div class="rodape">
    ${empresa_nome} · Orçamento válido até ${venc} · Sujeito a alteração de preços sem aviso prévio.
  </div>
</body>
</html>`;
}

module.exports = {
  start, stop, isRunning,
  imprimirLocal, adicionarNaFila,
  enviarParaServidor,
  listarImpressoras,
  gerarHtmlCupom,
  gerarHtmlCupomEntrega,
  gerarHtmlOrcamento,
};

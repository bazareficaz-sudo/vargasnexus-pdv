const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { abrir, EMPRESA, PRODUTO } = require('./helpers/venda-sync');
const { creditoClienteUsado } = require('../src/main/pagamentoVenda');
const { montarPayloadVendaV1 } = require('../src/main/payloadVendaV1');

// 1.19 — CRÉDITO DO CLIENTE COMO PAGAMENTO.
//
// Crédito do cliente é vale da loja (devolução, troca, pagamento a mais).
// Até a 1.18 o terminal tratava esse vale como dívida (aparecia em vermelho
// em "Em aberto" e comia o limite do fiado) e não deixava usá-lo numa venda.

const CLIENTE_LOCAL = 'cli-local-1';
const CLIENTE_REMOTO = '22222222-2222-4222-8222-222222222222';

function ambiente(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdv-credito-'));
  const db = abrir(dir);
  t.after(() => db.db().close());
  const raw = db.db();
  raw.prepare('INSERT INTO produtos (id, remote_id, nome, nome_lower, preco_venda) VALUES (?,?,?,?,?)')
    .run(PRODUTO, PRODUTO, 'TESTE', 'teste', 10);
  raw.prepare('INSERT INTO estoque (id, produto_id, quantidade) VALUES (?,?,100)').run('est', PRODUTO);
  raw.prepare('INSERT INTO clientes (id, remote_id, nome, nome_lower, saldo_credito) VALUES (?,?,?,?,?)')
    .run(CLIENTE_LOCAL, CLIENTE_REMOTO, 'Cliente', 'cliente', 123.06);
  db.creditosCliente.upsertBatch([
    { id: 'c-antigo', cliente_id: CLIENTE_REMOTO, valor_original: 100, saldo_atual: 100, status: 'aberto', created_date: '2026-10-01T00:00:00Z' },
    { id: 'c-novo', cliente_id: CLIENTE_REMOTO, valor_original: 23.06, saldo_atual: 23.06, status: 'aberto', created_date: '2026-11-20T00:00:00Z' },
  ]);
  return { db, raw };
}

const venda = (o) => ({
  empresa_id: EMPRESA, operador_nome: 'Op', cliente_id: CLIENTE_LOCAL, cliente_nome: 'Cliente',
  subtotal: o.total, desconto: 0, troco: 0, valor_pago: o.total,
  itens: [{ produto_id: PRODUTO, produto_nome: 'TESTE', quantidade: 1, preco_unitario: o.total, desconto: 0, total: o.total }],
  ...o,
});

describe('quanto da venda foi pago com crédito do cliente', () => {
  test('forma única credito_cliente: o total', () => {
    assert.equal(creditoClienteUsado({ forma_pagamento: 'credito_cliente', total: 45.5 }), 45.5);
  });
  test('Misto: só a parte credito_cliente, somada em centavos', () => {
    assert.equal(creditoClienteUsado({ forma_pagamento: 'misto', total: 100, pagamentos: [
      { forma: 'credito_cliente', valor: 23.06 }, { forma: 'pix', valor: 76.94 }] }), 23.06);
  });
  test('carteira (fiado) não é uso de crédito', () => {
    assert.equal(creditoClienteUsado({ forma_pagamento: 'carteira', total: 50 }), 0);
    assert.equal(creditoClienteUsado({ forma_pagamento: 'dinheiro', total: 50 }), 0);
  });
});

describe('a venda paga com crédito baixa o crédito no terminal', () => {
  test('do mais antigo para o mais novo, e o cadastro acompanha', t => {
    const { db, raw } = ambiente(t);
    db.vendas.registrar(venda({ total: 110, forma_pagamento: 'credito_cliente' }));
    const antigo = raw.prepare('SELECT saldo_atual, status FROM creditos_cliente WHERE id = ?').get('c-antigo');
    const novo = raw.prepare('SELECT saldo_atual, status FROM creditos_cliente WHERE id = ?').get('c-novo');
    assert.deepEqual([antigo.saldo_atual, antigo.status], [0, 'usado_totalmente']);
    assert.deepEqual([Math.round(novo.saldo_atual * 100), novo.status], [1306, 'usado_parcialmente']);
    assert.equal(Math.round(db.creditosCliente.resumoPorCliente(CLIENTE_REMOTO).total_saldo * 100), 1306);
    assert.equal(raw.prepare('SELECT saldo_credito FROM clientes WHERE id = ?').get(CLIENTE_LOCAL).saldo_credito, 13.06);
  });

  test('no Misto baixa só a parte do crédito', t => {
    const { db } = ambiente(t);
    db.vendas.registrar(venda({ total: 150, forma_pagamento: 'misto', pagamentos: [
      { forma: 'credito_cliente', valor: 123.06, sequencia: 1 }, { forma: 'pix', valor: 26.94, sequencia: 2 }] }));
    assert.equal(db.creditosCliente.resumoPorCliente(CLIENTE_REMOTO).total_saldo || 0, 0);
  });

  test('venda em carteira (fiado) não mexe no crédito', t => {
    const { db } = ambiente(t);
    db.vendas.registrar(venda({ total: 50, forma_pagamento: 'carteira', usa_credito: true }));
    assert.equal(Math.round(db.creditosCliente.resumoPorCliente(CLIENTE_REMOTO).total_saldo * 100), 12306);
  });

  test('crédito novo do servidor não sobrescreve venda com crédito que ainda não subiu', t => {
    const { db } = ambiente(t);
    assert.equal(db.creditosCliente.temVendaComCreditoPendente(CLIENTE_REMOTO), false);
    db.vendas.registrar(venda({ total: 10, forma_pagamento: 'credito_cliente' }));
    assert.equal(db.creditosCliente.temVendaComCreditoPendente(CLIENTE_REMOTO), true);
  });
});

describe('o pacote enviado ao servidor diz quanto baixar', () => {
  const base = { id: '44444444-4444-4444-8444-444444444444', numero: 1, total: 100, subtotal: 100, desconto: 0, itens: [] };
  const ctx = { empresaId: EMPRESA };
  test('venda em crédito: credito_cliente_usado = total, em v1', () => {
    const r = montarPayloadVendaV1({ ...base, forma_pagamento: 'credito_cliente' }, ctx);
    assert.ok(r.ok);
    assert.equal(r.payload.credito_cliente_usado, 100);
    assert.equal(r.payload.schema_version, 1);
  });
  test('Misto sem composição liberada (v1) ainda leva a parte do crédito', () => {
    const r = montarPayloadVendaV1({ ...base, forma_pagamento: 'misto', pagamentos: [
      { id: '55555555-5555-4555-8555-555555555555', forma: 'credito_cliente', valor: 40 },
      { id: '66666666-6666-4666-8666-666666666666', forma: 'dinheiro', valor: 60 }] }, ctx);
    assert.equal(r.payload.credito_cliente_usado, 40);
    assert.equal(r.payload.pagamentos, undefined);
  });
  test('venda sem crédito não leva o campo', () => {
    const r = montarPayloadVendaV1({ ...base, forma_pagamento: 'pix' }, ctx);
    assert.equal('credito_cliente_usado' in r.payload, false);
  });
});

describe('tela e atualização', () => {
  const pdv = fs.readFileSync(path.join(__dirname, '../src/renderer/pages/pdv.js'), 'utf8');
  const updater = fs.readFileSync(path.join(__dirname, '../src/main/updater.js'), 'utf8');
  test('"Em aberto" é o fiado (saldo_devedor), não o crédito', () => {
    const barra = pdv.slice(pdv.indexOf('async function renderClientBar'), pdv.indexOf('async function verContaCliente'));
    assert.match(barra, /saldo_devedor/);
    assert.doesNotMatch(barra, /emAberto = resumo/);
  });
  test('limite da carteira usa o fiado, não o crédito', () => {
    const conf = pdv.slice(pdv.indexOf("if (payMethod === 'carteira') {"), pdv.indexOf("valorPago = payMethod === 'dinheiro'"));
    assert.match(conf, /saldo_devedor/);
    assert.doesNotMatch(conf, /creditos\.resumo/);
  });
  test('atualização instala sozinha só com o balcão parado, e checa de 2 em 2 horas', () => {
    assert.match(updater, /__pdvPodeAtualizar/);
    assert.match(updater, /quitAndInstall\(true, true\)/);
    assert.doesNotMatch(updater, /showMessageBox/);
    assert.match(updater, /2 \* 60 \* 60 \* 1000/);
    assert.match(pdv, /window\.__pdvPodeAtualizar = \(\) =>\s*cart\.length === 0/);
  });
});

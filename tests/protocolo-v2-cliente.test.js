const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { montarPayloadVendaV1, SCHEMA_VERSION, FORMAS_SEM_V2 } = require('../src/main/payloadVendaV1');
const {
  interpretarResposta, lerPayloadPersistido, ESTADOS_SUCESSO, ESTADOS_TERMINAIS,
} = require('../src/main/protocoloVenda');

// FASE 4C.2 — CHECKPOINT 3, lado do terminal.
//
// O cliente aprende a falar v2. A propriedade que estes testes protegem é a
// que mantém a loja funcionando: enquanto ninguém pedir v2 explicitamente,
// o payload sai EXATAMENTE como sempre saiu.

const EMPRESA = '33333333-3333-4333-8333-333333333333';
const VENDA   = '44444444-4444-4444-8444-444444444444';
const ITEM    = '55555555-5555-4555-8555-555555555555';
const PAG1    = '66666666-6666-4666-8666-666666666666';
const PAG2    = '77777777-7777-4777-8777-777777777777';

const venda = (over = {}) => ({
  id: VENDA, empresa_id: EMPRESA, numero: 1,
  subtotal: 150, desconto: 0, total: 150,
  forma_pagamento: 'dinheiro', valor_pago: 150, troco: 0,
  status: 'concluida', created_at: '2026-10-08T12:00:00.000Z',
  itens: [{ id: ITEM, produto_remote_id: null, produto_nome: 'TESTE',
            quantidade: 1, preco_unitario: 150, desconto: 0, total: 150 }],
  ...over,
});

const composicao = [
  { id: PAG1, forma: 'dinheiro', valor: 50, valor_entregue: 60, troco: 10, sequencia: 1 },
  { id: PAG2, forma: 'credito', valor: 100, valor_entregue: null, troco: null, sequencia: 2 },
];

const montar = (v, ctx = {}) => montarPayloadVendaV1(v, { empresaId: EMPRESA, terminalId: 'PDV-001', ...ctx });

// ─────────────── O PADRÃO CONTINUA V1 ───────────────

describe('retrocompatibilidade: sem pedir, nada muda', () => {
  test('venda sem composicao local -> v1, sem o campo pagamentos', () => {
    const r = montar(venda());
    assert.equal(r.ok, true, r.erro);
    assert.equal(r.payload.schema_version, 1);
    assert.ok(!('pagamentos' in r.payload));
  });

  test('venda COM composicao local, mas sem pedir v2 -> ainda v1', () => {
    // É o caso da frota de hoje: o SQLite ja grava venda_pagamentos, mas o
    // protocolo so muda quando alguem liga.
    const r = montar(venda({ pagamentos: composicao }));
    assert.equal(r.payload.schema_version, 1);
    assert.ok(!('pagamentos' in r.payload));
  });

  test('SCHEMA_VERSION exportado continua 1', () => {
    assert.equal(SCHEMA_VERSION, 1);
  });

  test('o resto do payload é identico com e sem a composicao local', () => {
    const semComposicao = montar(venda()).payload;
    const comComposicao = montar(venda({ pagamentos: composicao })).payload;
    assert.deepEqual(comComposicao, semComposicao);
  });
});

// ─────────────── QUANDO O V2 É PEDIDO ───────────────

describe('composicao v2', () => {
  test('pedido + composicao local -> schema_version 2 com pagamentos', () => {
    const r = montar(venda({ pagamentos: composicao }), { pagamentosV2: true });
    assert.equal(r.ok, true, r.erro);
    assert.equal(r.payload.schema_version, 2);
    assert.equal(r.payload.pagamentos.length, 2);
  });

  test('os ids sao os LOCAIS — nunca gerados aqui', () => {
    const r = montar(venda({ pagamentos: composicao }), { pagamentosV2: true });
    assert.deepEqual(r.payload.pagamentos.map(p => p.id), [PAG1, PAG2]);
    // Duas chamadas produzem o mesmo payload: é o que sustenta a idempotencia.
    const outra = montar(venda({ pagamentos: composicao }), { pagamentosV2: true });
    assert.deepEqual(outra.payload, r.payload);
  });

  test('a soma dos pagamentos fecha com o total', () => {
    const r = montar(venda({ pagamentos: composicao }), { pagamentosV2: true });
    const soma = r.payload.pagamentos.reduce((s, p) => s + Math.round(p.valor * 100), 0);
    assert.equal(soma, Math.round(r.payload.total * 100));
  });

  test('entregue e troco nulos continuam NULOS, nao viram zero', () => {
    const r = montar(venda({ pagamentos: composicao }), { pagamentosV2: true });
    const cartao = r.payload.pagamentos.find(p => p.forma === 'credito');
    assert.equal(cartao.valor_entregue, null);
    assert.equal(cartao.troco, null);
    const dinheiro = r.payload.pagamentos.find(p => p.forma === 'dinheiro');
    assert.equal(dinheiro.valor_entregue, 60);
    assert.equal(dinheiro.troco, 10);
  });

  test('pedido sem composicao local -> cai para v1', () => {
    const r = montar(venda(), { pagamentosV2: true });
    assert.equal(r.payload.schema_version, 1);
    assert.ok(!('pagamentos' in r.payload));
  });

  test('pagamento sem id uuid -> cai para v1, nao inventa id', () => {
    const r = montar(venda({ pagamentos: [{ id: 'nao-uuid', forma: 'dinheiro', valor: 150 }] }),
      { pagamentosV2: true });
    assert.equal(r.payload.schema_version, 1);
  });
});

// ─────────────── A CARTEIRA FICA DE FORA ───────────────

describe('carteira nao vai em v2 enquanto o gatilho nao existir', () => {
  test('carteira esta na lista de formas sem v2', () => {
    assert.ok(FORMAS_SEM_V2.includes('carteira'));
  });

  test('venda com parcela em carteira -> v1, e sincroniza como sempre', () => {
    // Travar a venda em conflito seria pior que nao compor: o servidor
    // recusaria o payload v2 com carteira, porque a conta a receber nao
    // nasceria. Melhor a venda seguir pelo caminho que ja funciona.
    const r = montar(venda({ pagamentos: [
      { id: PAG1, forma: 'dinheiro', valor: 50 },
      { id: PAG2, forma: 'carteira', valor: 100 },
    ] }), { pagamentosV2: true });
    assert.equal(r.payload.schema_version, 1);
    assert.ok(!('pagamentos' in r.payload));
  });

  test('sem carteira, a mesma venda vai em v2', () => {
    const r = montar(venda({ pagamentos: composicao }), { pagamentosV2: true });
    assert.equal(r.payload.schema_version, 2);
  });
});

// ─────────────── OS ESTADOS NOVOS ───────────────

describe('interpretacao dos estados v2', () => {
  test('completada_v2 é SUCESSO, com telemetria propria', () => {
    assert.ok(ESTADOS_SUCESSO.includes('completada_v2'));
    const r = interpretarResposta({ estado: 'completada_v2' });
    assert.equal(r.desfecho, 'synced');
    assert.equal(r.telemetria, 'venda_sync_v2_completada');
  });

  test('conflito_pagamentos é TERMINAL, nao pendente', () => {
    assert.ok(ESTADOS_TERMINAIS.includes('conflito_pagamentos'));
    const r = interpretarResposta({ estado: 'conflito_pagamentos', motivo: 'composicao diferente' });
    assert.equal(r.desfecho, 'conflito');
    assert.equal(r.motivo, 'composicao diferente');
  });

  test('conflito_pagamentos é SEPARADO de conflito_payload', () => {
    // A venda comercial confere; o que diverge é a composicao. Misturar os
    // dois esconderia qual das duas coisas mudou.
    assert.notEqual(
      interpretarResposta({ estado: 'conflito_pagamentos' }).estado,
      interpretarResposta({ estado: 'conflito_payload' }).estado);
  });

  test('os estados antigos nao mudaram de desfecho', () => {
    for (const [estado, desfecho] of [['aplicada','synced'], ['ja_aplicada','synced'],
      ['completada_de_legado','synced'], ['conflito_payload','conflito'],
      ['payload_invalido','conflito'], ['desconhecido','pendente']]) {
      assert.equal(interpretarResposta({ estado }).desfecho, desfecho, estado);
    }
  });
});

// ─────────────── O SNAPSHOT CONGELADO ───────────────

describe('snapshot aceita v2 sem afrouxar a validacao', () => {
  const comSnapshot = payload => ({ id: VENDA, sync_payload_v1: JSON.stringify(payload) });
  const base = extra => ({
    schema_version: 1, venda_id: VENDA, empresa_id: EMPRESA,
    total: 150, subtotal: 150, desconto: 0, valor_pago: 150, troco: 0,
    itens: [{ id: ITEM, produto_id: null, quantidade: 1, preco_unitario: 150, desconto: 0, total: 150 }],
    ...extra,
  });

  test('snapshot v1 continua aceito', () => {
    const p = lerPayloadPersistido(comSnapshot(base()));
    assert.equal(p.schema_version, 1);
  });

  test('snapshot v2 integro é aceito', () => {
    const p = lerPayloadPersistido(comSnapshot(base({
      schema_version: 2, pagamentos: [{ id: PAG1, forma: 'dinheiro', valor: 150, sequencia: 1 }],
    })));
    assert.equal(p.schema_version, 2);
    assert.equal(p.pagamentos.length, 1);
  });

  test('snapshot v2 SEM pagamentos é bloqueado', () => {
    assert.throws(() => lerPayloadPersistido(comSnapshot(base({ schema_version: 2 }))),
      e => e.codigo === 'snapshot_v1_invalido');
  });

  test('snapshot v2 com pagamento sem id uuid é bloqueado', () => {
    assert.throws(() => lerPayloadPersistido(comSnapshot(base({
      schema_version: 2, pagamentos: [{ id: 'x', forma: 'dinheiro', valor: 150 }],
    }))), e => e.codigo === 'snapshot_v1_invalido');
  });

  test('snapshot v2 com valor nao positivo é bloqueado', () => {
    assert.throws(() => lerPayloadPersistido(comSnapshot(base({
      schema_version: 2, pagamentos: [{ id: PAG1, forma: 'dinheiro', valor: 0 }],
    }))), e => e.codigo === 'snapshot_v1_invalido');
  });

  test('schema_version 3 continua bloqueado', () => {
    assert.throws(() => lerPayloadPersistido(comSnapshot(base({ schema_version: 3 }))),
      e => e.codigo === 'snapshot_v1_invalido');
  });

  test('snapshot v2 capenga NAO vira v1 por conveniencia', () => {
    // Rebaixar silenciosamente mandaria para o servidor uma venda sem a
    // composicao que o operador registrou.
    assert.throws(() => lerPayloadPersistido(comSnapshot(base({
      schema_version: 2, pagamentos: [],
    }))), e => e.codigo === 'snapshot_v1_invalido');
  });
});

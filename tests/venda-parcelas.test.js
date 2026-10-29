const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const pag = require('../src/main/pagamentoVenda');
const { montarPayloadVendaV1 } = require('../src/main/payloadVendaV1');

// A PARCELA DO CARTAO.
//
// Ate aqui o sistema custeava TODA venda no credito como se fosse a vista:
// `venda_lanca_no_caixa_v1` chama `taxa_vigente_v1(forma, 1, data)` com o 1
// fixo no codigo, porque nao havia de onde ler outro numero. Em 90 dias de
// extrato do Mercado Pago o degrau de 1x apareceu 193 vezes ao centavo e os
// degraus de 2x a 6x nenhuma -- enquanto cobrancas de 5,50%, 6,65% e 8,20%
// apareciam "fora da tabela" contra um cadastro que tem 2x a 5,52%.
//
// O QUE ESTES TESTES PROTEGEM, em ordem de importancia:
//
//   1. Venda a vista continua identica. Ausente é 1, e 1 é o que toda venda
//      ja gravada quis dizer. Se isso quebrar, a loja para.
//   2. Numero invalido morre no motor, nao no INSERT nem no servidor.
//   3. A composicao multipla carrega parcela por pagamento -- porque uma
//      venda pode ter dois cartoes em numeros de parcela diferentes.

const EMPRESA = '33333333-3333-4333-8333-333333333333';
const VENDA   = '44444444-4444-4444-8444-444444444444';
const ITEM    = '55555555-5555-4555-8555-555555555555';
const PAG1    = '66666666-6666-4666-8666-666666666666';
const PAG2    = '77777777-7777-4777-8777-777777777777';

const venda = (over = {}) => ({
  id: VENDA, empresa_id: EMPRESA, numero: 1,
  subtotal: 150, desconto: 0, total: 150,
  forma_pagamento: 'dinheiro', valor_pago: 150, troco: 0,
  status: 'concluida', created_at: '2026-10-29T12:00:00.000Z',
  itens: [{ id: ITEM, produto_remote_id: null, produto_nome: 'TESTE',
            quantidade: 1, preco_unitario: 150, desconto: 0, total: 150 }],
  ...over,
});

const montar = (v, ctx = {}) =>
  montarPayloadVendaV1(v, { empresaId: EMPRESA, terminalId: 'PDV-001', ...ctx });

// ─────────────── O PADRAO É A VISTA ───────────────

describe('a venda a vista nao muda', () => {
  test('pagamento sem parcela é normalizado com 1', () => {
    const r = pag.validarPagamento({ forma: 'credito', valor: 100 }, 0);
    assert.equal(r.ok, true, r.erro);
    assert.equal(r.valor.parcelas, 1);
  });

  test('parcela 1 explicita e parcela ausente produzem o MESMO objeto', () => {
    const semDizer = pag.validarPagamento({ forma: 'credito', valor: 100 }, 0);
    const dizendo  = pag.validarPagamento({ forma: 'credito', valor: 100, parcelas: 1 }, 0);
    assert.deepEqual(semDizer.valor, dizendo.valor);
  });

  test('dinheiro com troco continua intacto, agora com parcelas 1', () => {
    const r = pag.validarPagamento(
      { forma: 'dinheiro', valor: 47, valor_entregue: 50, troco: 3 }, 0);
    assert.equal(r.ok, true, r.erro);
    assert.deepEqual(r.valor, {
      forma: 'dinheiro', valor: 47, valor_entregue: 50, troco: 3,
      sequencia: 1, parcelas: 1,
    });
  });
});

// ─────────────── O NUMERO INVALIDO MORRE AQUI ───────────────

describe('parcela invalida é recusada pelo motor', () => {
  for (const [rotulo, parcelas] of [
    ['zero', 0], ['negativa', -1], ['acima do teto', 100],
    ['quebrada', 2.5], ['texto', 'tres'], ['vazio que nao é ausencia', '  '],
  ]) {
    test(`${rotulo} (${JSON.stringify(parcelas)})`, () => {
      const r = pag.validarPagamento({ forma: 'credito', valor: 100, parcelas }, 0);
      assert.equal(r.ok, false);
      assert.match(r.erro, /parcelas/i);
    });
  }

  test('99 é o teto e passa', () => {
    assert.equal(pag.validarPagamento({ forma: 'credito', valor: 100, parcelas: 99 }, 0).ok, true);
  });

  // Nao é regra de cadastro: é fisica. O troco sai na hora ou nao sai.
  test('dinheiro parcelado nao existe', () => {
    const r = pag.validarPagamento({ forma: 'dinheiro', valor: 100, parcelas: 2 }, 0);
    assert.equal(r.ok, false);
    assert.match(r.erro, /dinheiro/i);
  });

  // Carne e credito do cliente SAO parcelados por ai. Quem limita é o
  // cadastro da loja, nao este modulo -- ele so sabe aritmetica.
  test('carteira e credito do cliente podem ser parcelados', () => {
    assert.equal(pag.validarPagamento({ forma: 'carteira', valor: 100, parcelas: 6 }, 0).ok, true);
    assert.equal(pag.validarPagamento({ forma: 'credito_cliente', valor: 100, parcelas: 4 }, 0).ok, true);
  });
});

// ─────────────── DOIS CARTOES, DUAS PARCELAS ───────────────

describe('a composicao carrega parcela por pagamento', () => {
  test('R$ 50 em dinheiro + R$ 100 no credito em 3x fecha em 150', () => {
    const r = pag.validarComposicao([
      { id: PAG1, forma: 'dinheiro', valor: 50, sequencia: 1 },
      { id: PAG2, forma: 'credito', valor: 100, sequencia: 2, parcelas: 3 },
    ], 150);
    assert.equal(r.ok, true, r.erro);
    assert.equal(r.valor[0].parcelas, 1);
    assert.equal(r.valor[1].parcelas, 3);
  });

  // A razao de a parcela morar no PAGAMENTO e nao na VENDA. Se morasse na
  // venda, uma destas duas linhas seria apagada pela outra.
  test('dois cartoes na mesma venda, em numeros de parcela diferentes', () => {
    const r = pag.validarComposicao([
      { forma: 'credito', valor: 60, sequencia: 1, parcelas: 2 },
      { forma: 'credito', valor: 90, sequencia: 2, parcelas: 6 },
    ], 150);
    assert.equal(r.ok, true, r.erro);
    assert.deepEqual(r.valor.map(p => p.parcelas), [2, 6]);
  });

  test('uma parcela invalida derruba a composicao inteira', () => {
    const r = pag.validarComposicao([
      { forma: 'dinheiro', valor: 50, sequencia: 1 },
      { forma: 'credito', valor: 100, sequencia: 2, parcelas: 0 },
    ], 150);
    assert.equal(r.ok, false);
    assert.match(r.erro, /Pagamento 2/);
  });

  // O caso REAL: uma das tres vendas mistas de producao, Balcao 03, 21/10,
  // gravada como "misto" e sem divisao nenhuma -- nem no SQLite, nem no
  // servidor. Com a tela de composicao, ela fecha assim.
  test('a venda misto de R$ 27,64 do Balcao 03 fecha ao centavo', () => {
    const r = pag.validarComposicao([
      { forma: 'dinheiro', valor: 10.00, valor_entregue: 10, troco: 0, sequencia: 1 },
      { forma: 'credito', valor: 17.64, sequencia: 2, parcelas: 3 },
    ], 27.64);
    assert.equal(r.ok, true, r.erro);
    assert.equal(pag.somarCentavos(r.valor), 2764);
  });
});

// ─────────────── O ADAPTADOR DA FORMA UNICA ───────────────

describe('comporDaVendaLocal', () => {
  test('sem parcela informada, o objeto sai como sempre saiu', () => {
    const [p] = pag.comporDaVendaLocal({ forma_pagamento: 'credito', total: 100 });
    assert.deepEqual(p, { forma: 'credito', valor: 100, sequencia: 1 });
    assert.ok(!('parcelas' in p), 'nao inventa a chave quando a UI nao disse nada');
  });

  test('com parcela informada, ela viaja', () => {
    const [p] = pag.comporDaVendaLocal({ forma_pagamento: 'credito', total: 100, parcelas: 3 });
    assert.equal(p.parcelas, 3);
  });

  test('o adaptador nao valida -- quem recusa é validarComposicao', () => {
    const lista = pag.comporDaVendaLocal({ forma_pagamento: 'dinheiro', total: 100, parcelas: 4 });
    assert.equal(lista.length, 1);
    assert.equal(pag.validarComposicao(lista, 100).ok, false);
  });
});

// ─────────────── O QUE CHEGA NO SERVIDOR ───────────────

describe('payload', () => {
  const comPag = (parcelas) => venda({
    pagamentos: [
      { id: PAG1, forma: 'dinheiro', valor: 50, valor_entregue: 50, troco: 0, sequencia: 1 },
      { id: PAG2, forma: 'credito', valor: 100, sequencia: 2, ...(parcelas == null ? {} : { parcelas }) },
    ],
  });

  test('sem pedir v2, nada muda: nem pagamentos, nem parcelas', () => {
    const r = montar(comPag(3));
    assert.equal(r.ok, true, r.erro);
    assert.equal(r.payload.schema_version, 1);
    assert.ok(!('pagamentos' in r.payload));
  });

  test('em v2 a parcela viaja', () => {
    const r = montar(comPag(3), { pagamentosV2: true });
    assert.equal(r.ok, true, r.erro);
    assert.equal(r.payload.schema_version, 2);
    assert.equal(r.payload.pagamentos[1].parcelas, 3);
  });

  // O servidor trata ausente e 1 como o MESMO hash, entao mandar 1 explicito
  // nao vira `conflito_pagamentos` numa venda que ja sincronizou.
  test('em v2, pagamento sem parcela viaja com 1 explicito', () => {
    const r = montar(comPag(null), { pagamentosV2: true });
    assert.equal(r.ok, true, r.erro);
    assert.equal(r.payload.pagamentos[0].parcelas, 1);
    assert.equal(r.payload.pagamentos[1].parcelas, 1);
  });

  test('o payload é estavel: montar duas vezes da o mesmo resultado', () => {
    const v = comPag(6);
    assert.deepEqual(
      montar(v, { pagamentosV2: true }).payload,
      montar(v, { pagamentosV2: true }).payload,
    );
  });
});

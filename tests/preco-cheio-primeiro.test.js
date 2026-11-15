const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// O PRECO CHEIO E O PRINCIPAL; O DESCONTO VEM COM A FORMA.
//
// A loja cobra assim: pede o valor de tabela e, conforme o cliente diz como
// paga, informa o valor com desconto. O PDV fazia o contrario -- a argamassa
// AC2 de R$ 25,50 aparecia na busca por R$ 25,50, entrava no carrinho por
// R$ 21,99, e o preco cheio sobrava num quadrinho lateral.
//
// A CAUSA nao era a regra de promocao, que ja sabia cobrar os dois precos
// conforme a forma. Era o valor inicial de `payMethod`: ele nasce 'dinheiro',
// dinheiro e forma a vista, e com isso o carrinho vinha com o desconto
// aplicado ANTES de alguem ter escolhido como paga. O desconto era dado por
// um valor de fabrica de variavel.
//
// Agora existe `formaEscolhida`, e o preco promocional depende dela: nao
// basta a forma ser a vista, alguem tem de ter escolhido essa forma.
//
// As funcoes abaixo saem do fonte e rodam de verdade, com carrinho de
// mentira. Teste de regex sobre codigo de preco confere a letra e deixa
// passar a conta.

const FONTE = fs.readFileSync(path.resolve(__dirname, '../src/renderer/pages/pdv.js'), 'utf8');

function extrair(assinatura) {
  const i = FONTE.indexOf(assinatura);
  assert.notEqual(i, -1, `nao achei: ${assinatura}`);
  // Conta chaves a partir da primeira `{` da declaracao.
  let abre = FONTE.indexOf('{', i), nivel = 0, j = abre;
  for (; j < FONTE.length; j++) {
    if (FONTE[j] === '{') nivel++;
    else if (FONTE[j] === '}') { nivel--; if (nivel === 0) break; }
  }
  return FONTE.slice(i, j + 1);
}

/** Monta um PDV de bolso com so o que a regra de preco precisa. */
function pdv({ cart = [], payMethod = 'dinheiro', formaEscolhida = false,
               formasAvista = ['pix', 'dinheiro'], desconto = 0 } = {}) {
  const ctx = {
    cart, payMethod, formaEscolhida, formasAvista,
    getDesconto: () => desconto,
    Math,
  };
  vm.createContext(ctx);
  for (const fn of [
    'function _formaEhAvista(',
    'function _promoValeAgora(',
    'function _temItemEmPromocao(',
    'function _aplicarPrecoPorFormaPagamento(',
    'function calcularTotaisPromocao(',
  ]) vm.runInContext(extrair(fn), ctx);
  return ctx;
}

/** A AC2 da foto: tabela 25,50, promocao 21,99. */
function ac2(precoAtual = 25.5) {
  return {
    produto_nome: 'SEUMOTA ARGAMASSA AC2 20KG',
    quantidade: 1,
    preco_unitario: precoAtual,
    preco_tabela: 25.5,
    preco_promocional: 21.99,
    em_promocao: true,
    preco_manual: false,
    devolucao: false,
    total: precoAtual,
  };
}

describe('enquanto ninguem escolheu a forma', () => {
  test('o preco promocional NAO vale, mesmo com dinheiro na variavel', () => {
    // Era exatamente este o defeito: 'dinheiro' e forma a vista, entao o
    // valor inicial da variavel ja dava o desconto.
    const p = pdv({ payMethod: 'dinheiro', formaEscolhida: false });
    assert.equal(p._formaEhAvista('dinheiro'), true, 'dinheiro continua sendo a vista');
    assert.equal(p._promoValeAgora(), false, 'mas a promocao nao vale sem escolha');
  });

  test('o carrinho fica no preco de TABELA', () => {
    const p = pdv({ cart: [ac2(21.99)], payMethod: 'dinheiro', formaEscolhida: false });
    p._aplicarPrecoPorFormaPagamento();
    assert.equal(p.cart[0].preco_unitario, 25.5);
    assert.equal(p.cart[0].total, 25.5);
  });

  test('vale para pix tambem, nao so para dinheiro', () => {
    const p = pdv({ cart: [ac2(21.99)], payMethod: 'pix', formaEscolhida: false });
    p._aplicarPrecoPorFormaPagamento();
    assert.equal(p.cart[0].preco_unitario, 25.5);
  });
});

describe('quando a forma e escolhida', () => {
  test('a vista, o desconto aparece', () => {
    const p = pdv({ cart: [ac2(25.5)], payMethod: 'dinheiro', formaEscolhida: true });
    p._aplicarPrecoPorFormaPagamento();
    assert.equal(p.cart[0].preco_unitario, 21.99);
    assert.equal(p.cart[0].total, 21.99);
  });

  test('no cartao, continua o cheio', () => {
    const p = pdv({ cart: [ac2(21.99)], payMethod: 'credito', formaEscolhida: true });
    p._aplicarPrecoPorFormaPagamento();
    assert.equal(p.cart[0].preco_unitario, 25.5);
  });

  test('trocar de dinheiro para cartao sobe o preco de volta', () => {
    // Ida e volta na mesma venda: o cliente muda de ideia no balcao.
    const p = pdv({ cart: [ac2(25.5)], payMethod: 'dinheiro', formaEscolhida: true });
    p._aplicarPrecoPorFormaPagamento();
    assert.equal(p.cart[0].preco_unitario, 21.99);
    p.payMethod = 'credito';
    p._aplicarPrecoPorFormaPagamento();
    assert.equal(p.cart[0].preco_unitario, 25.5);
  });

  test('a lista de formas a vista continua vindo da configuracao', () => {
    // `promo_formas` do termometro. Uma loja que considere debito a vista
    // tem de continuar mandando nisso.
    const p = pdv({ cart: [ac2(25.5)], payMethod: 'debito', formaEscolhida: true,
                    formasAvista: ['pix', 'dinheiro', 'debito'] });
    p._aplicarPrecoPorFormaPagamento();
    assert.equal(p.cart[0].preco_unitario, 21.99);
  });
});

describe('o que a escolha nao pode atropelar', () => {
  test('preco digitado a mao fica como o vendedor deixou', () => {
    const item = { ...ac2(23), preco_manual: true };
    const p = pdv({ cart: [item], payMethod: 'dinheiro', formaEscolhida: true });
    p._aplicarPrecoPorFormaPagamento();
    assert.equal(p.cart[0].preco_unitario, 23);
  });

  test('devolucao nao e reprecificada', () => {
    const item = { ...ac2(25.5), devolucao: true };
    const p = pdv({ cart: [item], payMethod: 'dinheiro', formaEscolhida: true });
    p._aplicarPrecoPorFormaPagamento();
    assert.equal(p.cart[0].preco_unitario, 25.5);
  });

  test('item fora de promocao nao se mexe em nenhum dos dois estados', () => {
    const comum = { ...ac2(10), em_promocao: false, preco_promocional: null, preco_tabela: 10 };
    for (const escolhida of [false, true]) {
      const p = pdv({ cart: [{ ...comum }], payMethod: 'dinheiro', formaEscolhida: escolhida });
      p._aplicarPrecoPorFormaPagamento();
      assert.equal(p.cart[0].preco_unitario, 10, `escolhida=${escolhida}`);
    }
  });
});

describe('os dois cenarios mostrados ao vendedor', () => {
  test('continuam independentes da escolha -- e e assim que se oferece', () => {
    // O quadro "ofereça ao cliente" precisa mostrar os DOIS precos antes de o
    // cliente decidir. Se ele dependesse de `formaEscolhida`, o vendedor
    // perderia justamente a informacao que usa para negociar.
    for (const escolhida of [false, true]) {
      const p = pdv({ cart: [ac2(25.5)], payMethod: 'credito', formaEscolhida: escolhida });
      const t = p.calcularTotaisPromocao();
      assert.equal(t.temPromo, true);
      assert.equal(t.totalAvista, 21.99, `escolhida=${escolhida}`);
      assert.equal(t.totalCartao, 25.5, `escolhida=${escolhida}`);
    }
  });

  test('o desconto do rodape desce dos dois', () => {
    const p = pdv({ cart: [ac2(25.5)], desconto: 1.5 });
    const t = p.calcularTotaisPromocao();
    assert.equal(Number(t.totalAvista.toFixed(2)), 20.49);
    assert.equal(Number(t.totalCartao.toFixed(2)), 24.00);
  });
});

describe('a trava que impede cobrar a mais em silencio', () => {
  test('o carrinho sabe dizer se tem item em promocao', () => {
    assert.equal(pdv({ cart: [ac2()] })._temItemEmPromocao(), true);
    assert.equal(pdv({ cart: [] })._temItemEmPromocao(), false);
    assert.equal(pdv({ cart: [{ ...ac2(), em_promocao: false }] })._temItemEmPromocao(), false);
    assert.equal(pdv({ cart: [{ ...ac2(), preco_manual: true }] })._temItemEmPromocao(), false);
    assert.equal(pdv({ cart: [{ ...ac2(), devolucao: true }] })._temItemEmPromocao(), false);
  });

  test('confirmar sem escolher a forma e recusado quando ha promocao', () => {
    // Sem isto, `payMethod` de fabrica gravaria a venda como dinheiro pelo
    // preco cheio: o cliente pagou a vista e foi cobrado a mais.
    const fn = extrair('async function _confirmarPagamento(');
    assert.match(fn, /!formaEscolhida && _temItemEmPromocao\(\)/);
    assert.match(fn, /Escolha a forma de pagamento/);
  });

  test('venda sem promocao continua fechando sem clique extra', () => {
    const fn = extrair('async function _confirmarPagamento(');
    // A recusa e condicionada ao carrinho ter promocao -- 94% das vendas da
    // loja nao tem, e nelas nada muda.
    assert.match(fn, /if \(!formaEscolhida && _temItemEmPromocao\(\)\)/);
  });

  test('o modal nao acende forma nenhuma enquanto a escolha e exigida', () => {
    assert.match(FONTE, /const exigirEscolha = !formaEscolhida && _temItemEmPromocao\(\)/);
    assert.match(FONTE, /!exigirEscolha && payMethod === o\.key \? 'active' : ''/);
  });

  test('clicar numa forma marca a escolha', () => {
    const fn = extrair('function _selectPay(');
    assert.match(fn, /formaEscolhida = true/);
  });
});

describe('os estados herdados', () => {
  test('carrinho limpo volta a cobrar o cheio', () => {
    const fn = extrair('function clearCart(');
    assert.match(fn, /formaEscolhida = false/);
  });

  test('atendimento em espera volta sem desconto dado', () => {
    // Ele parou ANTES do pagamento. Voltar com `true` entregaria o desconto
    // de um cliente que nunca disse como paga.
    assert.match(FONTE, /formaEscolhida = v\.formaEscolhida === true/);
    assert.match(FONTE, /formaEscolhida,\s*\n\s*valorPago, modoEdicao,/);
  });

  test('venda ja paga que volta para edicao mantem a forma dela', () => {
    // Reabrir cobrando o cheio mudaria o preco de uma venda ja paga.
    const i = FONTE.indexOf("payMethod = venda.forma_pagamento");
    assert.notEqual(i, -1);
    assert.match(FONTE.slice(i, i + 400), /formaEscolhida = true/);
  });
});

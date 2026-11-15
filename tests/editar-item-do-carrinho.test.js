const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// O MODAL DA LINHA DO CARRINHO RESOLVE A VENDA INTEIRA.
//
// Antes ele tinha preço e desconto, e mais nada. Quando o cliente dizia "não
// quero 10 parafusos, quero 150", o vendedor tinha duas saídas ruins: apagar
// o item e lançar de novo, ou clicar 140 vezes no "+". E para saber quanto o
// produto sai à vista ele precisava procurá-lo OUTRA VEZ na busca, de código
// em código, num orçamento de dez itens.
//
// Agora a quantidade se digita, e o painel mostra os quatro números que ele
// precisava: cheio, à vista, cobrando agora e total da linha.
//
// A conta mora em `calcularEdicaoItem`, sem DOM. Os testes abaixo tiram a
// função do fonte e a EXECUTAM — teste de regex sobre código de preço confere
// a letra e deixa passar a conta.

const FONTE = fs.readFileSync(path.resolve(__dirname, '../src/renderer/pages/pdv.js'), 'utf8');

function extrair(assinatura) {
  const i = FONTE.indexOf(assinatura);
  assert.notEqual(i, -1, `nao achei: ${assinatura}`);
  // Pular a LISTA DE PARÂMETROS primeiro. `calcularEdicaoItem({ item, ... })`
  // recebe um objeto desestruturado: começar a contar na primeira `{` pararia
  // no fim do parâmetro e devolveria uma função pela metade.
  let p = FONTE.indexOf('(', i), par = 0, k = p;
  for (; k < FONTE.length; k++) {
    if (FONTE[k] === '(') par++;
    else if (FONTE[k] === ')') { par--; if (par === 0) break; }
  }
  let nivel = 0, j = FONTE.indexOf('{', k);
  for (; j < FONTE.length; j++) {
    if (FONTE[j] === '{') nivel++;
    else if (FONTE[j] === '}') { nivel--; if (nivel === 0) break; }
  }
  return FONTE.slice(i, j + 1);
}

const ctx = vm.createContext({});
vm.runInContext(extrair('function calcularEdicaoItem('), ctx);
vm.runInContext(extrair('function markupDoItem('), ctx);
const { calcularEdicaoItem, markupDoItem } = ctx;

/** Um item de carrinho como o PDV monta: a AC1 da foto, 10 unidades. */
function item(extra = {}) {
  return {
    produto_id: 'p1',
    produto_nome: 'SEUMOTA ARGAMASSA AC1 20KG',
    quantidade: 10,
    preco_unitario: 12.75,
    preco_tabela: 12.75,
    preco_promocional: 10.99,
    preco_custo: 10,
    em_promocao: true,
    preco_manual: false,
    desconto: 0,
    estoque_max: 200,
    devolucao: false,
    total: 127.5,
    ...extra,
  };
}

describe('a quantidade que o cliente mudou de ideia', () => {
  test('10 vira 150 sem apagar e lançar de novo', () => {
    const r = calcularEdicaoItem({ item: item(), novoPreco: 12.75, novaQuantidade: 150 });
    assert.equal(r.ok, true);
    assert.equal(r.quantidade, 150);
    assert.equal(r.total, 1912.5);
  });

  test('quantidade fracionária continua valendo — existe venda por metro', () => {
    const r = calcularEdicaoItem({ item: item(), novoPreco: 12.75, novaQuantidade: 2.5 });
    assert.equal(r.ok, true);
    assert.equal(r.quantidade, 2.5);
    assert.equal(r.total, 31.875);
  });

  test('zero não esvazia a linha pela porta dos fundos', () => {
    // Zerar aqui deixaria no carrinho um item de total zero. Tirar item é o ✕.
    const r = calcularEdicaoItem({ item: item(), novoPreco: 12.75, novaQuantidade: 0 });
    assert.equal(r.ok, false);
    assert.match(r.erro, /✕/);
  });

  test('negativo é recusado — devolução se lança na busca, não aqui', () => {
    assert.equal(calcularEdicaoItem({ item: item(), novoPreco: 12.75, novaQuantidade: -3 }).ok, false);
  });

  test('campo vazio ou letra não viram quantidade', () => {
    for (const q of [NaN, undefined, null, '', 'abc']) {
      assert.equal(calcularEdicaoItem({ item: item(), novoPreco: 12.75, novaQuantidade: q }).ok, false, String(q));
    }
  });
});

describe('o estoque continua mandando', () => {
  test('acima do disponível é recusado, e a recusa diz quanto tem', () => {
    const r = calcularEdicaoItem({ item: item({ estoque_max: 120 }), novoPreco: 12.75, novaQuantidade: 150 });
    assert.equal(r.ok, false);
    assert.match(r.erro, /120/);
  });

  test('a loja que permite estoque negativo passa — é a mesma regra do + e do −', () => {
    const r = calcularEdicaoItem({
      item: item({ estoque_max: 120 }), novoPreco: 12.75, novaQuantidade: 150,
      permiteEstoqueNegativo: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.quantidade, 150);
  });

  test('exatamente o estoque passa', () => {
    assert.equal(calcularEdicaoItem({ item: item({ estoque_max: 150 }), novoPreco: 12.75, novaQuantidade: 150 }).ok, true);
  });
});

describe('o preço', () => {
  test('preço negativo é recusado', () => {
    assert.equal(calcularEdicaoItem({ item: item(), novoPreco: -1, novaQuantidade: 10 }).ok, false);
  });

  test('preço mexido na mão marca a linha como manual', () => {
    // Senão a troca de forma de pagamento sobrescreveria o que o vendedor
    // combinou com o cliente.
    const r = calcularEdicaoItem({ item: item(), novoPreco: 11, novaQuantidade: 10 });
    assert.equal(r.preco_manual, true);
    assert.equal(r.preco_unitario, 11);
  });

  test('mexer SÓ na quantidade não marca a linha como manual', () => {
    // Esta linha está em promoção: marcá-la manual aqui congelaria o preço e
    // o cliente perderia o desconto ao escolher dinheiro.
    const r = calcularEdicaoItem({ item: item(), novoPreco: 12.75, novaQuantidade: 150 });
    assert.equal(r.preco_manual, false);
    assert.equal(r.preco_unitario, 12.75);
  });

  test('quem já era manual continua manual', () => {
    const r = calcularEdicaoItem({ item: item({ preco_manual: true }), novoPreco: 12.75, novaQuantidade: 20 });
    assert.equal(r.preco_manual, true);
  });

  test('centavo nenhum de diferença não conta como alteração', () => {
    const r = calcularEdicaoItem({ item: item(), novoPreco: 12.752, novaQuantidade: 10 });
    assert.equal(r.preco_manual, false);
    assert.equal(r.preco_unitario, 12.75);
  });
});

describe('o desconto da linha, que agora acompanha a quantidade', () => {
  test('desconto dado em 10 unidades vale pelas 10', () => {
    const r = calcularEdicaoItem({ item: item(), novoPreco: 11.75, novaQuantidade: 10 });
    assert.equal(r.desconto, 10);   // R$ 1,00 por unidade
  });

  test('mudar a quantidade DEPOIS do desconto recalcula o desconto', () => {
    // Era exatamente este o defeito: o desconto ficava gravado como total e,
    // ao passar de 10 para 150 parafusos, o pedido saía com o desconto de 10.
    const comDesconto = item({ preco_unitario: 11.75, desconto: 10, preco_manual: true });
    const r = calcularEdicaoItem({ item: comDesconto, novoPreco: 11.75, novaQuantidade: 150 });
    assert.equal(r.desconto, 150);  // R$ 1,00 por unidade, 150 unidades
    assert.equal(r.total, 1762.5);
  });

  test('dois descontos seguidos somam, não se substituem', () => {
    const primeiro = calcularEdicaoItem({ item: item(), novoPreco: 11.75, novaQuantidade: 10 });
    const depois = item({ preco_unitario: primeiro.preco_unitario, desconto: primeiro.desconto, preco_manual: true });
    const segundo = calcularEdicaoItem({ item: depois, novoPreco: 11.25, novaQuantidade: 10 });
    assert.equal(segundo.desconto, 15);   // R$ 1,00 + R$ 0,50 por unidade
  });

  test('subir o preço de volta desfaz o desconto, e não vira desconto negativo', () => {
    const comDesconto = item({ preco_unitario: 11.75, desconto: 10, preco_manual: true });
    const r = calcularEdicaoItem({ item: comDesconto, novoPreco: 14, novaQuantidade: 10 });
    assert.equal(r.desconto, 0);
  });

  test('linha sem desconto nenhum continua com desconto zero', () => {
    const r = calcularEdicaoItem({ item: item(), novoPreco: 12.75, novaQuantidade: 30 });
    assert.equal(r.desconto, 0);
  });
});

describe('o markup que o modal mostra', () => {
  test('custo 10, cobrando 12,75 — 27,5%', () => {
    assert.equal(markupDoItem(12.75, 10).toFixed(1), '27.5');
  });

  test('sem custo cadastrado não há markup, e isso se diz com null', () => {
    // Zero aqui seria mentira: markup zero é vender pelo custo.
    assert.equal(markupDoItem(12.75, 0), null);
    assert.equal(markupDoItem(12.75, null), null);
    assert.equal(markupDoItem(12.75, undefined), null);
  });

  test('vender abaixo do custo dá markup negativo, e tem de aparecer', () => {
    assert.ok(markupDoItem(8, 10) < 0);
  });
});

describe('os números que acompanham a digitação', () => {
  // `_previewEdicaoItem` roda de verdade, contra um DOM de mentira: o que
  // interessa aqui é o texto que aparece no painel enquanto o vendedor digita.
  function painel(itemDoCarrinho, { qtd, preco, permiteEstoqueNegativo = false }) {
    const campos = {
      'ei-qtd': { value: String(qtd) },
      'ei-preco': { value: String(preco) },
      'ei-cobrando': { textContent: '', style: {} },
      'ei-total': { textContent: '', style: {} },
      'ei-economia': { textContent: '', style: {} },
      'ei-economia-valor': { textContent: '', style: {} },
      'ei-margem': { textContent: '', style: {} },
      'ei-aviso': { textContent: '', style: {} },
    };
    const ctx = vm.createContext({
      document: { getElementById: (id) => campos[id] || null },
      cart: [itemDoCarrinho],
      _edicaoItem: { produtoId: itemDoCarrinho.produto_id, permiteEstoqueNegativo },
    });
    vm.runInContext('function fmtMoney(v){return (v||0).toFixed(2).replace(".",",");}', ctx);
    vm.runInContext(extrair('function markupDoItem('), ctx);
    vm.runInContext(extrair('function _previewEdicaoItem('), ctx);
    vm.runInContext('_previewEdicaoItem()', ctx);
    return campos;
  }

  test('digitar 150 mostra o total da linha sem precisar salvar', () => {
    const p = painel(item(), { qtd: 150, preco: 12.75 });
    assert.equal(p['ei-total'].textContent, 'R$ 1912,50');
    assert.equal(p['ei-cobrando'].textContent, 'R$ 12,75');
  });

  test('o desconto da linha aparece quando o preço fica abaixo do cheio', () => {
    const p = painel(item(), { qtd: 10, preco: 11.75 });
    assert.equal(p['ei-economia'].style.display, 'flex');
    assert.equal(p['ei-economia-valor'].textContent, '- R$ 10,00');
  });

  test('cobrando o preço cheio, não há linha de desconto para mostrar', () => {
    const p = painel(item(), { qtd: 10, preco: 12.75 });
    assert.equal(p['ei-economia'].style.display, 'none');
  });

  test('o markup acompanha o preço digitado', () => {
    const p = painel(item(), { qtd: 10, preco: 12.75 });
    assert.match(p['ei-margem'].textContent, /Custo R\$ 10,00/);
    assert.match(p['ei-margem'].textContent, /Markup 27\.5%/);
    assert.match(p['ei-margem'].textContent, /Lucro R\$ 27,50/);
  });

  test('passar do estoque avisa, mas o painel segue calculando', () => {
    const p = painel(item({ estoque_max: 120 }), { qtd: 150, preco: 12.75 });
    assert.equal(p['ei-aviso'].style.display, 'block');
    assert.match(p['ei-aviso'].textContent, /120/);
    assert.equal(p['ei-total'].textContent, 'R$ 1912,50');
  });

  test('na loja que vende sem estoque, nem aviso aparece', () => {
    const p = painel(item({ estoque_max: 120 }), { qtd: 150, preco: 12.75, permiteEstoqueNegativo: true });
    assert.equal(p['ei-aviso'].style.display, 'none');
  });

  test('campo em branco não escreve NaN na tela', () => {
    const p = painel(item(), { qtd: '', preco: '' });
    assert.equal(p['ei-total'].textContent, 'R$ 0,00');
    assert.equal(p['ei-cobrando'].textContent, 'R$ 0,00');
  });
});

describe('o que a tela promete', () => {
  test('o painel traz os quatro números que ele procurava na busca', () => {
    for (const rotulo of ['Preço cheio (tabela)', 'À vista (promoção)', 'Cobrando agora', 'Total da linha']) {
      assert.ok(FONTE.includes(rotulo), `faltou o rótulo: ${rotulo}`);
    }
  });

  test('o preço à vista só aparece quando a linha está em promoção', () => {
    assert.match(FONTE, /const temPromo = item\.em_promocao && item\.preco_promocional != null/);
  });

  test('custo e markup ficam atrás da mesma permissão do resto do PDV', () => {
    const fn = extrair('async function abrirEditarItem(');
    assert.match(fn, /podePermissao\('ver_lucro_margem'\)/);
    assert.match(fn, /podeVerCusto \? `/);
  });

  test('a quantidade se digita e os números acompanham a digitação', () => {
    const fn = extrair('async function abrirEditarItem(');
    assert.match(fn, /id="ei-qtd"/);
    assert.match(fn, /oninput="PDV\._previewEdicaoItem\(\)"/);
  });

  test('clicar na linha do carrinho continua sendo o que abre o modal', () => {
    assert.match(FONTE, /onclick="PDV\.abrirEditarItem\('\$\{item\.produto_id\}'\)"/);
    assert.match(FONTE, /title="Clique para editar quantidade, preço e desconto"/);
  });

  test('salvar passa pela mesma conta que os testes acima executam', () => {
    const fn = extrair('function _salvarEdicaoItem(');
    assert.match(fn, /calcularEdicaoItem\(\{/);
    assert.match(fn, /if \(!novo\.ok\)/);
  });

  test('o estoque do aviso não bloqueia a digitação, só o Salvar', () => {
    const fn = extrair('function _previewEdicaoItem(');
    assert.match(fn, /Aviso, não bloqueio/);
  });
});

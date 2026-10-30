const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

// O CUPOM DO ORCAMENTO VIRA UMA PROPOSTA.
//
// Antes: itens, total, "Forma de pagamento: A Combinar". O cliente levava o
// papel e comparava com a loja da esquina, que escreveu "3x sem juros" no
// dela. Medido: 72 orcamentos em 12 meses, 69 ainda "aberto".
//
// Agora o papel diz, em corpo grande, as duas formas de pagar — e o item sai
// pelo preco cheio para a promocao poder reaparecer como desconto a vista.

function carregarComStore(config) {
  const filename = path.resolve(__dirname, '../src/main/print-server.js');
  const req = Module.createRequire(filename);
  const mod = { exports: {} };
  const StoreFalso = class {
    get(chave) { return config[chave]; }
    set() {}
  };
  const mocks = {
    'electron-store': StoreFalso,
    electron: { app: { getPath: () => require('node:os').tmpdir(), isPackaged: false },
                BrowserWindow: class {}, ipcMain: { handle() {}, on() {} } },
  };
  const exec = vm.runInThisContext(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename });
  exec(mod.exports, n => Object.hasOwn(mocks, n) ? mocks[n] : req(n), mod, filename, path.dirname(filename));
  return mod.exports;
}

const N = require('../src/main/negociacaoOrcamento');

const CFG = {
  taxa_pix_pct: 0.49, taxa_dinheiro_pct: 0, taxa_debito_pct: 1.11,
  taxa_credito_vista_pct: 3.04, taxa_credito_parc_pct: 2.48,
  imposto_pct: 5, custo_operacional_pct: 0, comissao_vendedor_pct: 0,
  custo_embalagem: 0, frete_subsidiado_pct: 0,
  orcamento_promo_vira_desconto: true,
  orcamento_promo_formas: ['pix', 'dinheiro'],
  orcamento_parcela_minima: 50, orcamento_parcelas_max: 6,
  orcamento_parcelas_sem_juros: true,
};
const FAIXAS = [
  { nome: 'Excelente', margem_min: 70, desconto_max_pct: 10, permite_parcelamento: true, max_parcelas: 6 },
  { nome: 'Boa', margem_min: 50, desconto_max_pct: 5, permite_parcelamento: true, max_parcelas: 3 },
  { nome: 'Atenção', margem_min: 30, desconto_max_pct: 2, permite_parcelamento: false, max_parcelas: 1 },
  { nome: 'Prejuízo', margem_min: null, desconto_max_pct: 0, permite_parcelamento: false, max_parcelas: 1 },
];

const ITENS = [
  { produto_id: 'p1', produto_nome: 'CAIXA DAGUA 500L', quantidade: 1, preco_unitario: 270, total: 270 },
  { produto_id: 'p2', produto_nome: 'ADAPTADOR 50MM', quantidade: 2, preco_unitario: 22, total: 44 },
];
const CATALOGO = [
  { id: 'p1', preco_venda: 300, preco_custo: 60, preco_promocional: 270, promocao_ativa: true },
  { id: 'p2', preco_venda: 22, preco_custo: 5 },   // sem promocao
];

function cupom({ store = {}, descontoManualPct = 0, politica } = {}) {
  const { gerarHtmlOrcamento } = carregarComStore(store);
  const negociacao = N.calcular({
    itens: ITENS, descontoManualPct,
    politica: politica ?? { config: CFG, faixas: FAIXAS },
    buscarProdutos: () => CATALOGO,
  });
  return {
    html: gerarHtmlOrcamento({
      numero: 1247, empresa_nome: 'BAZAR EFICAZ', itens: ITENS,
      subtotal: 314, desconto: 0, total: 314, negociacao,
    }),
    negociacao,
  };
}

describe('o bloco de condicoes', () => {
  test('aparece em corpo grande, com as duas formas', () => {
    const { html } = cupom();
    assert.match(html, /COMO VOCÊ PODE PAGAR/);
    assert.match(html, /NO CARTÃO/);
    assert.match(html, /PIX OU DINHEIRO/);
    assert.match(html, /cond-valor/);
  });

  test('o parcelamento diz o valor da parcela, nao so o numero', () => {
    // "6x sem juros" sem o valor obriga o cliente a fazer conta no papel —
    // e e exatamente nesse momento que ele compara com a outra loja.
    const { html, negociacao } = cupom();
    const parcela = (negociacao.totalExibido / negociacao.condicoes.parcelasMax).toFixed(2).replace('.', ',');
    assert.match(html, new RegExp(`${negociacao.condicoes.parcelasMax}x de`));
    assert.ok(html.includes(parcela), `esperava a parcela ${parcela} no papel`);
    assert.match(html, /sem juros/);
  });

  test('o a vista diz o valor E a economia', () => {
    const { html } = cupom();
    assert.match(html, /você economiza/);
    assert.match(html, /R\$ 30,00/);   // 344 cheio − 314 praticado
  });

  test('a validade fica em destaque', () => {
    // Proposta sem prazo nao cria motivo nenhum para voltar hoje.
    assert.match(cupom().html, /Esta proposta vale até/);
  });
});

describe('o item sai pelo preco CHEIO', () => {
  test('o total impresso é o cheio, nao o praticado', () => {
    const { html, negociacao } = cupom();
    assert.equal(negociacao.totalExibido, 344);   // 300 + 2×22
    assert.equal(negociacao.vitrine.totalPraticado, 314);
    assert.match(html, /R\$ 344,00/);
  });

  test('o item em promocao ganha a linha da economia; o sem promocao, nao', () => {
    // O item sem promocao fica VISIVELMENTE sem a linha — mostra sozinho que
    // ali nao ha desconto a dar, sem gastar uma coluna para repetir o mesmo
    // numero duas vezes.
    const { html } = cupom();
    const linhaCaixa = html.slice(html.indexOf('CAIXA DAGUA'), html.indexOf('ADAPTADOR'));
    const linhaAdapt = html.slice(html.indexOf('ADAPTADOR'), html.indexOf('</table>'));
    assert.match(linhaCaixa, /prod-avista/);
    assert.match(linhaCaixa, /à vista R\$ 270,00 — economiza R\$ 30,00/);
    assert.doesNotMatch(linhaAdapt, /prod-avista/);
  });

  test('e o preco unitario impresso é o de tabela', () => {
    const { html } = cupom();
    assert.match(html, /R\$ 300,00/);        // cheio da caixa
    assert.doesNotMatch(html, /1 × R\$ 270,00/);  // o praticado nao aparece
  });
});

describe('sem negociacao, o cupom antigo continua', () => {
  test('cai na linha de forma de pagamento de sempre', () => {
    const { gerarHtmlOrcamento } = carregarComStore({});
    const html = gerarHtmlOrcamento({
      numero: 1, empresa_nome: 'X', itens: ITENS,
      subtotal: 314, desconto: 0, total: 314, forma_pagamento: 'pix',
    });
    assert.match(html, /Forma de pagamento/);
    assert.doesNotMatch(html, /COMO VOCÊ PODE PAGAR/);
    assert.match(html, /R\$ 314,00/);
  });
});

describe('o rodape vem da configuracao, nao do codigo', () => {
  test('usa a mensagem da empresa, a mesma do cupom de venda', () => {
    // Texto fixo aqui seria um segundo lugar para manter o telefone.
    const { html } = cupom({
      store: { 'config.cupom_mensagem_empresa': 'Fechou? Chama no zap 21 99817-0077' },
    });
    assert.match(html, /Chama no zap 21 99817-0077/);
    assert.doesNotMatch(html, /Obrigado pela preferência!/);
  });

  test('e é ESCAPADO — o texto vem de fora', () => {
    const { html } = cupom({
      store: { 'config.cupom_mensagem_empresa': 'Promo <b>50%</b> & "cia"' },
    });
    assert.match(html, /&lt;b&gt;50%&lt;\/b&gt; &amp; &quot;cia&quot;/);
  });
});

describe('o desconto manual no papel', () => {
  test('substitui o da promocao', () => {
    const { html, negociacao } = cupom({ descontoManualPct: 20 });
    assert.equal(negociacao.condicoes.descontoAvistaPct, 20);
    assert.match(html, /R\$ 275,20/);   // 344 × 0,80
  });

  test('manual MENOR que a promocao ainda imprime — e a tela que avisa', () => {
    // O papel nao esconde a escolha de quem negociou. Quem alerta é a tela,
    // antes de imprimir.
    const { html, negociacao } = cupom({ descontoManualPct: 3 });
    assert.ok(negociacao.aviso, 'a negociacao deveria trazer o aviso');
    assert.match(html, /COMO VOCÊ PODE PAGAR/);
  });
});

describe('faixa apertada tira o parcelamento do papel', () => {
  test('markup em "Atenção" imprime so o a vista', () => {
    const caro = [
      { id: 'p1', preco_venda: 300, preco_custo: 185, preco_promocional: 270, promocao_ativa: true },
      { id: 'p2', preco_venda: 22, preco_custo: 15 },
    ];
    const { gerarHtmlOrcamento } = carregarComStore({});
    const negociacao = N.calcular({
      itens: ITENS, politica: { config: CFG, faixas: FAIXAS }, buscarProdutos: () => caro,
    });
    assert.equal(negociacao.saude.base.faixa.nome, 'Atenção');
    assert.equal(negociacao.condicoes.parcelasMax, null);
    const html = gerarHtmlOrcamento({ numero: 1, itens: ITENS, total: 314, negociacao });
    assert.doesNotMatch(html, /NO CARTÃO/);
    assert.match(html, /PIX OU DINHEIRO/);
  });
});

describe('o total da linha acompanha o unitario', () => {
  test('nao imprime "1 × R$ 300,00" com total de R$ 270,00', () => {
    // Incoerencia que o cliente acha em dois segundos, e que ele usa para
    // desconfiar do resto do papel.
    const { html } = cupom();
    const linha = html.slice(html.indexOf('CAIXA DAGUA'), html.indexOf('ADAPTADOR'));
    assert.match(linha, /1 × R\$ 300,00/);
    assert.match(linha, /R\$ 300,00<\/td>/);
    // O 270 aparece de propósito, mas SÓ na linha da economia — nunca como
    // total da linha, que é onde a incoerência moraria.
    assert.doesNotMatch(linha, /R\$ 270,00<\/td>/);
  });

  test('e a soma das linhas bate com o TOTAL', () => {
    const { html, negociacao } = cupom();
    const totais = [...html.matchAll(/class="right prod-total">R\$ ([\d.,]+)</g)]
      .map(m => Number(m[1].replace(/\./g, '').replace(',', '.')));
    const soma = Math.round(totais.reduce((s, v) => s + v, 0) * 100) / 100;
    assert.equal(soma, negociacao.totalExibido,
      `linhas somam ${soma}, TOTAL impresso é ${negociacao.totalExibido}`);
  });
});

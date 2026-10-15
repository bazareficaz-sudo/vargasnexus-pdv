const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const C = require('../src/main/condicoesOrcamento');
const S = require('../src/main/saudeOrcamento');

// A NEGOCIACAO DO ORCAMENTO, NO BALCAO.
//
// Medido em producao: 72 orcamentos em 12 meses, 69 ainda "aberto", ticket
// medio R$ 246,43, 8 com parcelamento preenchido. O vendedor imprime e
// entrega um papel que so tem itens e total; o cliente compara com uma loja
// que escreveu "3x sem juros" no dela.
//
// Estes testes travam as contas que viram texto no papel. Sao puros: nao
// precisam de banco, de tela nem de Electron.

// As taxas REAIS do Bazar Eficaz, lidas de saude_config em 15/10/2026.
// Numeros inventados aqui fariam os testes concordarem com nada.
const CFG = {
  taxa_pix_pct: 0.49,
  taxa_dinheiro_pct: 0,
  taxa_debito_pct: 1.11,
  taxa_credito_vista_pct: 3.04,
  taxa_credito_parc_pct: 2.48,
  imposto_pct: 5,
  custo_operacional_pct: 0,
  comissao_vendedor_pct: 0,
  custo_embalagem: 0,
  frete_subsidiado_pct: 0,
};

// As faixas REAIS do Bazar Eficaz.
const FAIXAS = [
  { nome: 'Excelente', margem_min: 70, margem_max: null, desconto_max_pct: 10, permite_parcelamento: true, max_parcelas: 6 },
  { nome: 'Boa', margem_min: 50, margem_max: 69, desconto_max_pct: 5, permite_parcelamento: true, max_parcelas: 3 },
  { nome: 'Atenção', margem_min: 30, margem_max: 49, desconto_max_pct: 2, permite_parcelamento: false, max_parcelas: 1 },
  { nome: 'Crítica', margem_min: 5, margem_max: 29, desconto_max_pct: 0, permite_parcelamento: false, max_parcelas: 1 },
  { nome: 'Prejuízo', margem_min: null, margem_max: 4.99, desconto_max_pct: 0, permite_parcelamento: false, max_parcelas: 1, bloqueia_venda: true },
];

const item = (preco, custo, qtd = 1) => ({ preco_unitario: preco, custo, quantidade: qtd });

describe('o que o cartao parcelado custa de verdade', () => {
  test('credito e `a vista + (n-1) x parcelado`', () => {
    // A leitura ingenua ("parcelado custa 2,48%") subestima pela metade.
    assert.equal(S.taxaPorForma('credito', 1, CFG), 3.04);
    assert.equal(S.taxaPorForma('credito', 3, CFG), 8.00);
    assert.equal(S.taxaPorForma('credito', 4, CFG), 10.48);
  });

  test('4x no cartao custa quase o mesmo que 10% a vista', () => {
    // É o argumento que o vendedor pode usar sem perder nada: a loja esta
    // praticamente indiferente entre as duas condicoes.
    const cartao4x = S.taxaPorForma('credito', 4, CFG);
    const pix = S.taxaPorForma('pix', 1, CFG);
    assert.ok(Math.abs((cartao4x - pix) - 10) < 0.1,
      `diferenca foi ${(cartao4x - pix).toFixed(2)}pp, esperava ~10pp`);
  });

  test('dinheiro nao custa nada e Pix quase nada', () => {
    assert.equal(S.taxaPorForma('dinheiro', 1, CFG), 0);
    assert.equal(S.taxaPorForma('pix', 1, CFG), 0.49);
  });

  test('forma desconhecida cai em dinheiro, nao em NaN', () => {
    assert.equal(S.taxaPorForma('cheque', 1, CFG), 0);
  });
});

describe('a faixa que a margem alcanca', () => {
  test('margem alta cai em Excelente', () => {
    assert.equal(S.encontrarFaixa(75, FAIXAS).nome, 'Excelente');
  });

  test('OS VAOS ENTRE AS FAIXAS nao jogam a margem no Prejuizo', () => {
    // Em producao as faixas deixam vao: Boa vai ate 69 e Excelente comeca em
    // 70. Com a regra de janela (>= min && < max), 69,5% — uma margem otima —
    // nao casava com nenhuma e caia no fallback, que e a ULTIMA faixa:
    // Prejuizo. E Prejuizo tem bloqueia_venda: true.
    //
    // Os quatro vaos reais: 4,99-5, 29-30, 49-50 e 69-70.
    for (const m of [69.5, 69, 49.5, 49, 29.5]) {
      const f = S.encontrarFaixa(m, FAIXAS);
      assert.notEqual(f.nome, 'Prejuízo', `margem ${m}% nao pode ser Prejuizo`);
    }
  });

  test('e cada margem cai no degrau certo', () => {
    assert.equal(S.encontrarFaixa(69.5, FAIXAS).nome, 'Boa');
    assert.equal(S.encontrarFaixa(70, FAIXAS).nome, 'Excelente');
    assert.equal(S.encontrarFaixa(50, FAIXAS).nome, 'Boa');
    assert.equal(S.encontrarFaixa(49.5, FAIXAS).nome, 'Atenção');
    assert.equal(S.encontrarFaixa(30, FAIXAS).nome, 'Atenção');
  });
  test('margem negativa cai em Prejuizo, que bloqueia', () => {
    const f = S.encontrarFaixa(-20, FAIXAS);
    assert.equal(f.nome, 'Prejuízo');
    assert.equal(f.bloqueia_venda, true);
  });

  test('sem faixas configuradas, usa as de fabrica', () => {
    assert.ok(S.encontrarFaixa(40, []));
    assert.ok(S.encontrarFaixa(40, null));
  });
});

describe('a margem muda com a condicao de pagamento', () => {
  // Um orcamento de R$ 100 com custo R$ 30.
  const itens = [item(100, 30)];

  test('a vista no Pix sobra mais que parcelado no cartao', () => {
    const pix = S.avaliar(itens, 0, 'pix', 1, CFG, FAIXAS);
    const cartao = S.avaliar(itens, 0, 'credito', 4, CFG, FAIXAS);
    assert.ok(pix.margem > cartao.margem,
      `pix ${pix.margem}% deveria ser maior que cartao 4x ${cartao.margem}%`);
    // A diferenca é exatamente a taxa: 10,48% − 0,49%.
    assert.ok(Math.abs((pix.margem - cartao.margem) - 9.99) < 0.02);
  });

  test('o desconto entra em reais, nao em percentual', () => {
    // Confundir os dois daria 10% onde se quis R$ 10 — ou o contrario.
    const a = S.avaliar(itens, 10, 'pix', 1, CFG, FAIXAS);
    assert.equal(a.totalComDesc, 90);
  });

  test('desconto maior que o total nao gera total negativo', () => {
    const a = S.avaliar(itens, 500, 'pix', 1, CFG, FAIXAS);
    assert.equal(a.totalComDesc, 0);
    assert.equal(a.margem, 0);
  });

  test('o imposto entra na conta', () => {
    // 5% de imposto sobre R$ 100: sem ele a margem sairia 5pp melhor.
    const comImposto = S.avaliar(itens, 0, 'dinheiro', 1, CFG, FAIXAS);
    const sem = S.avaliar(itens, 0, 'dinheiro', 1, { ...CFG, imposto_pct: 0 }, FAIXAS);
    assert.ok(Math.abs((sem.margem - comImposto.margem) - 5) < 0.01);
  });

  test('carrinho vazio nao divide por zero', () => {
    const a = S.avaliar([], 0, 'pix', 1, CFG, FAIXAS);
    assert.equal(a.margem, 0);
    assert.equal(a.totalBruto, 0);
  });
});

describe('sem custo cadastrado, a faixa NAO opina', () => {
  test('a avaliacao avisa', () => {
    const a = S.avaliar([item(100, 0)], 0, 'pix', 1, CFG, FAIXAS);
    assert.equal(a.semCusto, true);
    // A margem sai inflada: sem custo, tudo parece lucro.
    assert.ok(a.margem > 90, `margem foi ${a.margem}`);
  });

  test('e o teto de parcelas vira null', () => {
    // Faixa inflada liberaria parcelamento que a venda nao sustenta.
    const a = S.avaliar([item(100, 0)], 0, 'pix', 1, CFG, FAIXAS);
    assert.equal(S.tetoDeParcelasDaFaixa(a), null);
  });

  test('com custo, o teto vem da faixa', () => {
    // R$ 100 com custo R$ 40: margem ~54% -> faixa "Boa" -> 3x.
    const a = S.avaliar([item(100, 40)], 0, 'pix', 1, CFG, FAIXAS);
    assert.equal(a.faixa.nome, 'Boa');
    assert.equal(S.tetoDeParcelasDaFaixa(a), 3);
  });

  test('faixa que proibe parcelamento devolve 1, nao null', () => {
    // 1 é "so a vista", decidido. null seria "nao sei", e aí o teto da
    // empresa valeria sozinho — o oposto do que a faixa manda.
    const a = S.avaliar([item(100, 60)], 0, 'pix', 1, CFG, FAIXAS);
    assert.equal(a.faixa.nome, 'Atenção');
    assert.equal(S.tetoDeParcelasDaFaixa(a), 1);
  });
});

describe('promocao virando desconto a vista', () => {
  test('a media é PONDERADA pelo valor, nao pelos percentuais', () => {
    // 10% num item de R$ 1.000 e 50% num de R$ 10 nao é um desconto de 30%.
    const v = C.calcularVitrinePromo([
      { quantidade: 1, precoCheio: 1000, precoPraticado: 900 },
      { quantidade: 1, precoCheio: 10, precoPraticado: 5 },
    ]);
    assert.equal(v.totalCheio, 1010);
    assert.equal(v.totalPraticado, 905);
    assert.ok(Math.abs(v.descontoPct - 10.4) < 0.01, `deu ${v.descontoPct}`);
  });

  test('a conta FECHA: a vista sobre o cheio cai no praticado', () => {
    // É a propriedade que sustenta a estrategia inteira. Se nao fechasse, o
    // papel prometeria um preco que a venda nao cobraria.
    const itens = [
      { quantidade: 2, precoCheio: 22, precoPraticado: 19.8 },
      { quantidade: 4, precoCheio: 1.4, precoPraticado: 1.26 },
    ];
    const v = C.calcularVitrinePromo(itens);
    const aVista = C.totalAvista(v.totalCheio, { descontoAvistaPct: v.descontoPct });
    assert.ok(Math.abs(aVista - v.totalPraticado) < 0.02,
      `a vista ${aVista} vs praticado ${v.totalPraticado}`);
  });

  test('preco cheio MENOR que o praticado nao vira desconto negativo', () => {
    // Tabela desatualizada ou negociacao para cima. Sem o `max`, apareceria
    // "-15% de desconto" na tela.
    const v = C.calcularVitrinePromo([{ quantidade: 1, precoCheio: 80, precoPraticado: 100 }]);
    assert.equal(v.descontoPct, 0);
    assert.equal(v.temPromo, false);
  });

  test('sem promocao nenhuma, temPromo é falso', () => {
    const v = C.calcularVitrinePromo([{ quantidade: 3, precoCheio: 10, precoPraticado: 10 }]);
    assert.equal(v.temPromo, false);
    assert.equal(v.descontoPct, 0);
  });

  test('lista vazia nao quebra', () => {
    const v = C.calcularVitrinePromo([]);
    assert.equal(v.totalCheio, 0);
    assert.equal(v.temPromo, false);
  });
});

describe('o aviso do desconto manual', () => {
  test('manual MENOR que a promocao piora o preco — avisa', () => {
    const aviso = C.avisoDescontoManual(5, 10);
    assert.ok(aviso, 'deveria avisar');
    assert.match(aviso, /PIOR/);
    assert.match(aviso, /10%/);
    assert.match(aviso, /5%/);
  });

  test('manual maior ou igual nao avisa', () => {
    assert.equal(C.avisoDescontoManual(10, 10), null);
    assert.equal(C.avisoDescontoManual(15, 10), null);
  });

  test('sem promocao, ou sem manual, nao ha o que avisar', () => {
    assert.equal(C.avisoDescontoManual(5, 0), null);
    assert.equal(C.avisoDescontoManual(0, 10), null);
    assert.equal(C.avisoDescontoManual(null, null), null);
  });
});

describe('as frases que saem no papel e no zap', () => {
  const cond = {
    descontoAvistaPct: 10,
    avistaFormas: ['pix', 'dinheiro'],
    parcelasMax: 4,
    parcelasSemJuros: true,
    observacao: null,
  };

  test('a linha do a vista diz o valor e a economia', () => {
    const linhas = C.linhasCondicoes(246.43, cond);
    assert.match(linhas[0], /Pix ou dinheiro/);
    assert.match(linhas[0], /221,79/);
    assert.match(linhas[0], /economiza/);
  });

  test('a linha do parcelamento diz o valor da parcela', () => {
    const linhas = C.linhasCondicoes(246.43, cond);
    assert.match(linhas[1], /4x de/);
    assert.match(linhas[1], /61,61/);
    assert.match(linhas[1], /sem juros/);
  });

  test('1x NAO vira linha de parcelamento', () => {
    // "Ou em ate 1x" nao é condicao, é ruido.
    const linhas = C.linhasCondicoes(80, { ...cond, parcelasMax: 1 });
    assert.equal(linhas.filter(l => /x de/.test(l)).length, 0);
  });

  test('sem desconto a vista, so o parcelamento', () => {
    const linhas = C.linhasCondicoes(200, { ...cond, descontoAvistaPct: 0 });
    assert.equal(linhas.length, 1);
    assert.match(linhas[0], /4x/);
  });

  test('a observacao entra como ultima linha', () => {
    const linhas = C.linhasCondicoes(200, { ...cond, observacao: '  Entrega em 3 dias  ' });
    assert.equal(linhas[linhas.length - 1], 'Entrega em 3 dias');
  });

  test('temCondicoes distingue proposta de papel vazio', () => {
    assert.equal(C.temCondicoes(cond), true);
    assert.equal(C.temCondicoes({ descontoAvistaPct: 0, parcelasMax: 1, observacao: '   ' }), false);
  });
});

describe('parcelas: a regra da parcela minima', () => {
  const cfg = { parcelaMinima: 50, teto: 6 };

  test('os casos do lojista', () => {
    assert.equal(C.parcelasSugeridas(80, cfg), 1);
    assert.equal(C.parcelasSugeridas(100, cfg), 2);
    assert.equal(C.parcelasSugeridas(150, cfg), 3);
  });

  test('a parcela nunca cai abaixo da minima', () => {
    for (const t of [50, 99, 149.99, 150, 275, 1000]) {
      const n = C.parcelasSugeridas(t, cfg);
      if (n > 1) assert.ok(t / n >= 50, `R$ ${t} em ${n}x`);
    }
  });

  test('o teto da faixa aperta, nunca afrouxa', () => {
    assert.equal(C.parcelasSugeridas(1000, { ...cfg, tetoFaixa: 3 }), 3);
    assert.equal(C.parcelasSugeridas(1000, { ...cfg, tetoFaixa: 12 }), 6);
  });

  test('ponta a ponta: orcamento real com faixa real', () => {
    // R$ 1.000 com custo R$ 450 -> margem 49,51% -> faixa "Atenção" ->
    // parcelamento proibido, mesmo com teto 6 e total que daria 20x.
    const a = S.avaliar([item(1000, 450)], 0, 'pix', 1, CFG, FAIXAS);
    assert.equal(a.faixa.nome, 'Atenção');
    assert.equal(C.parcelasSugeridas(1000, {
      ...cfg, tetoFaixa: S.tetoDeParcelasDaFaixa(a),
    }), 1);
  });

  test('e o mesmo orcamento com margem boa parcela em 3', () => {
    const a = S.avaliar([item(1000, 400)], 0, 'pix', 1, CFG, FAIXAS);
    assert.equal(a.faixa.nome, 'Boa');
    assert.equal(C.parcelasSugeridas(1000, {
      ...cfg, tetoFaixa: S.tetoDeParcelasDaFaixa(a),
    }), 3);
  });
});

describe('a mensagem do WhatsApp', () => {
  const dados = {
    numero: 1247,
    empresaNome: 'Bazar Eficaz',
    clienteNome: 'Maria',
    itens: [{ produto_nome: 'ADAPTADOR 50MM', quantidade: 2, preco_unitario: 22, total: 44 }],
    total: 44,
    validade: '2026-10-22',
    condicoes: { descontoAvistaPct: 10, avistaFormas: ['pix'], parcelasMax: 1, parcelasSemJuros: true },
  };

  test('traz numero, itens, total e condicoes', () => {
    const m = C.montarMensagemOrcamento(dados);
    assert.match(m, /\*Orçamento #1247\* — Bazar Eficaz/);
    assert.match(m, /Para: Maria/);
    assert.match(m, /2x ADAPTADOR 50MM/);
    assert.match(m, /\*Total: R\$\s*44,00\*/);
    assert.match(m, /Condições de pagamento/);
    assert.match(m, /Válido até 22\/10\/2026/);
  });

  test('acima de 20 itens resume em vez de virar parede de texto', () => {
    const muitos = Array.from({ length: 25 }, (_, i) => ({
      produto_nome: `ITEM ${i}`, quantidade: 1, preco_unitario: 1, total: 1,
    }));
    const m = C.montarMensagemOrcamento({ ...dados, itens: muitos });
    assert.match(m, /e mais 5 item\(ns\)/);
    assert.ok(!m.includes('ITEM 22'), 'nao deveria listar o 23o item');
  });
});

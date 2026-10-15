// A NEGOCIAÇÃO DE UM ORÇAMENTO, MONTADA NUM LUGAR SÓ.
//
// Junta as três peças — catálogo local, condições comerciais e saúde — e
// devolve tudo que a tela e o papel precisam mostrar. A tela não recalcula
// nada: duas cópias da regra divergem, e aí a tela passa a mentir sobre o
// que vai sair impresso.
//
// ── POR QUE O ITEM PRECISA SER ENRIQUECIDO AQUI ──────────────────────────
//
// O item do carrinho de orçamento não guarda custo nem preço cheio, e o item
// de um orçamento já salvo muito menos — ele vem do banco com o preço
// praticado e mais nada. Sem custo não há margem; sem preço cheio não há
// promoção a transformar em desconto à vista.
//
// Buscar no catálogo local resolve os dois casos com o mesmo código, e
// funciona offline, que é o estado normal de um balcão com internet ruim.
//
// `buscarProdutos` entra por parâmetro em vez de `require('./database')`
// para este módulo poder ser testado sem banco, sem Electron e sem disco.

const C = require('./condicoesOrcamento');
const S = require('./saudeOrcamento');

const num = (v, padrao = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
};

/** A promoção está valendo HOJE? Mesma regra de `promocaoVigente` no PDV. */
function emPromocao(p, agora = new Date()) {
  if (!p || !p.promocao_ativa) return false;
  const promo = num(p.preco_promocional);
  if (!(promo > 0)) return false;
  const normal = num(p.preco_venda);
  if (normal > 0 && promo >= normal) return false;
  const inicio = p.promocao_inicio ? new Date(p.promocao_inicio) : null;
  if (inicio && !isNaN(inicio) && agora < inicio) return false;
  const fim = p.promocao_fim ? new Date(p.promocao_fim) : null;
  if (fim && !isNaN(fim) && agora > fim) return false;
  return true;
}

/**
 * @param itens             [{ produto_id, produto_nome, quantidade, preco_unitario, desconto }]
 * @param descontoManualPct desconto que o vendedor digitou (0 = não digitou)
 * @param politica          { config, faixas } de `/api/pdv/saude`
 * @param buscarProdutos    (ids) => [{ id, preco_venda, preco_custo, promocao_* }]
 */
function calcular({ itens, descontoManualPct, politica, buscarProdutos, agora } = {}) {
  const lista = Array.isArray(itens) ? itens : [];
  const cfg = politica?.config || {};
  const faixas = politica?.faixas || [];

  const catalogo = new Map(
    (buscarProdutos ? buscarProdutos(lista.map((i) => i.produto_id).filter(Boolean)) : [])
      .map((p) => [p.id, p]));

  const enriquecidos = lista.map((i) => {
    const p = catalogo.get(i.produto_id);
    const praticado = num(i.preco_unitario);
    // Preço cheio só existe se a promoção está VIGENTE. Promoção fora da
    // janela de datas não é promoção — tratá-la como tal transformaria um
    // desconto de fim de semana em desconto à vista para sempre.
    const cheio = p && emPromocao(p, agora) ? num(p.preco_venda) : praticado;
    return {
      ...i,
      quantidade: num(i.quantidade),
      precoPraticado: praticado,
      precoCheio: Math.max(cheio, praticado),
      custo: p ? num(p.preco_custo) : 0,
      temPromo: p ? emPromocao(p, agora) : false,
    };
  });

  const vitrine = C.calcularVitrinePromo(enriquecidos);
  const estrategiaLigada = cfg.orcamento_promo_vira_desconto === true;
  const aplicaEstrategia = estrategiaLigada && vitrine.temPromo;

  // O total que o cliente lê. Com a estratégia ligada é o CHEIO, e a promoção
  // reaparece embaixo como condição à vista.
  const totalExibido = aplicaEstrategia ? vitrine.totalCheio : vitrine.totalPraticado;

  // ── Saúde medida À VISTA, e o porquê ──────────────────────────────────
  //
  // A saúde escolhe a taxa a partir das parcelas, e as parcelas sugeridas
  // querem a faixa da saúde. Medir a faixa COM o parcelamento que ainda vai
  // ser decidido é raciocínio em círculo.
  //
  // A pergunta certa é "que margem este orçamento tem ANTES de eu conceder
  // parcelamento" — é ela que decide se cabe parcelar.
  const paraSaude = enriquecidos.map((i) => ({
    custo: i.custo,
    preco_unitario: i.precoPraticado,
    quantidade: i.quantidade,
  }));
  const manualPct = num(descontoManualPct);
  const base = S.avaliar(paraSaude, 0, 'pix', 1, cfg, faixas);

  const parcelas = C.parcelasSugeridas(totalExibido, {
    parcelaMinima: num(cfg.orcamento_parcela_minima, 50),
    teto: num(cfg.orcamento_parcelas_max, 6),
    tetoFaixa: S.tetoDeParcelasDaFaixa(base),
  });

  // ── Desconto à vista: manual manda, promoção é o padrão ───────────────
  //
  // Regra do lojista: se digitou desconto manual, ele DESCONSIDERA a
  // promoção e vale sozinho. Não somam.
  const descontoAvistaPct = manualPct > 0
    ? manualPct
    : (aplicaEstrategia ? vitrine.descontoPct : 0);

  const condicoes = {
    descontoAvistaPct,
    avistaFormas: (cfg.orcamento_promo_formas && cfg.orcamento_promo_formas.length)
      ? cfg.orcamento_promo_formas : ['pix', 'dinheiro'],
    parcelasMax: parcelas > 1 ? parcelas : null,
    parcelasSemJuros: cfg.orcamento_parcelas_sem_juros !== false,
    observacao: null,
  };

  // ── O VALOR À VISTA É UM PREÇO, NÃO UMA CONTA DE PERCENTUAL ───────────
  //
  // Quando o desconto vem da promoção, o valor à vista JÁ EXISTE: é a soma
  // dos preços promocionais, que é o que o PDV vai cobrar. O percentual é
  // descrição, e descrição arredondada em duas casas.
  //
  // Visto numa prévia com produtos reais: 1.465,00 cheio, 6,96% de desconto
  // ponderado, e `1465 × (1 − 0,0696)` dá 1.363,04 — quatro centavos acima
  // dos 1.363,00 que a venda cobraria. O papel prometeria um preço que a
  // loja não pratica, e por diferença pequena demais para alguém desconfiar
  // antes do caixa.
  //
  // Com desconto MANUAL é o contrário: ali o percentual é a decisão, e o
  // valor sai dele.
  const totalAvista = (manualPct > 0 || !aplicaEstrategia)
    ? C.totalAvista(totalExibido, condicoes)
    : vitrine.totalPraticado;

  // Quanto de desconto é, medido sobre o preço praticado — que é por onde os
  // itens entram no cálculo de margem.
  const descontoSobrePraticado = (valorCobrado) =>
    Math.round((vitrine.totalPraticado - valorCobrado) * 100) / 100;

  return {
    totalExibido,
    totalAvista,
    vitrine,
    aplicaEstrategia,
    condicoes,
    linhas: C.linhasCondicoes(totalExibido, condicoes),
    itens: enriquecidos,
    // A saúde de CADA condição — o ponto da tela. O vendedor vê o chão antes
    // de negociar, em vez de descobrir depois.
    //
    // Os itens entram pelo preço PRATICADO, então o desconto a informar é a
    // diferença entre o praticado e o que vai ser realmente cobrado. Ela pode
    // ser NEGATIVA — à vista com manual de 5% sobre promoção de 10%, ou no
    // cartão pelo preço cheio, o cliente paga MAIS que o praticado. Negativo
    // aqui é a verdade, não erro a esconder.
    saude: {
      avista: S.avaliar(paraSaude, descontoSobrePraticado(totalAvista),
        condicoes.avistaFormas[0] || 'pix', 1, cfg, faixas),
      parcelado: parcelas > 1
        ? S.avaliar(paraSaude, descontoSobrePraticado(totalExibido), 'credito', parcelas, cfg, faixas)
        : null,
      base,
    },
    // Avisa quando o desconto manual é MENOR que a promoção: o papel passaria
    // a oferecer à vista um preço pior do que o do balcão hoje.
    aviso: manualPct > 0 && vitrine.temPromo
      ? C.avisoDescontoManual(manualPct, vitrine.descontoPct)
      : null,
    // Sem custo a margem é ficção, e quem lê precisa saber antes de confiar
    // no semáforo.
    semCusto: base.semCusto,
  };
}

module.exports = { calcular, emPromocao };

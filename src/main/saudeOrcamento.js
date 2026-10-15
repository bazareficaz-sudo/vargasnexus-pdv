// SAÚDE DO ORÇAMENTO — quanto sobra depois de custo, taxa, imposto e comissão.
//
// Espelha `calcSaude` de `pdv-vargas-web/src/lib/saude-venda.ts`, com a mesma
// ordem de contas e os mesmos nomes, para o número do balcão e o número do
// escritório serem o mesmo número.
//
// ── POR QUE UM MÓDULO NOVO, E NÃO O saude-venda.js DO RENDERER ───────────
//
// O terminal já tem um cálculo de saúde na tela de venda, mas ele roda com
// faixas FIXAS NO CÓDIGO (30/15/8%) e lê a política de `config_desconto` —
// tabela que está VAZIA em produção. Por isso a tela mostra "desconto máx.
// 12%": um número que ninguém configurou.
//
// A política de verdade (70/50/30/5%, desconto 10/5/2%) vive em
// `saude_faixas`, que o `anon` não pode ler, e chega aqui pela rota
// autenticada `/api/pdv/saude`.
//
// Este módulo usa a política de verdade e é usado SÓ pelo orçamento. A tela
// de venda fica como está, de propósito: trocar a régua dela mudaria o que o
// vendedor vê no meio do atendimento — uma venda de 35% de margem sairia de
// "Excelente, até 12%" para "Atenção, até 2%". Isso é decisão de loja, não de
// código, e quando for tomada é só apontar a tela de venda para cá.

// As de fábrica, usadas só quando o servidor ainda não respondeu. Mesmos
// valores de `FAIXAS_PADRAO` no web.
const FAIXAS_PADRAO = [
  { nome: 'Excelente', emoji: '🟢', cor: '#16a34a', margem_min: 35, margem_max: null, desconto_max_pct: 10, permite_parcelamento: true, max_parcelas: 12, bloqueia_venda: false, exige_autorizacao: false },
  { nome: 'Boa', emoji: '🟡', cor: '#ca8a04', margem_min: 25, margem_max: 35, desconto_max_pct: 5, permite_parcelamento: true, max_parcelas: 3, bloqueia_venda: false, exige_autorizacao: false },
  { nome: 'Atenção', emoji: '🟠', cor: '#ea580c', margem_min: 15, margem_max: 25, desconto_max_pct: 2, permite_parcelamento: false, max_parcelas: 1, bloqueia_venda: false, exige_autorizacao: false },
  { nome: 'Crítica', emoji: '🔴', cor: '#dc2626', margem_min: 5, margem_max: 15, desconto_max_pct: 0, permite_parcelamento: false, max_parcelas: 1, bloqueia_venda: false, exige_autorizacao: true },
  { nome: 'Prejuízo', emoji: '⚫', cor: '#1c1917', margem_min: null, margem_max: 5, desconto_max_pct: 0, permite_parcelamento: false, max_parcelas: 1, bloqueia_venda: true, exige_autorizacao: true },
];

const num = (v, padrao = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
};

// A taxa do crédito é `à vista + (n-1) × parcelado`. Com as taxas do Bazar
// Eficaz (3,04% e 2,48%), 3x custa 8,00% da venda e 4x custa 10,48% — quase
// o mesmo que dar 10% de desconto à vista. É a conta que o vendedor precisa
// enxergar para negociar sem perder dinheiro sem perceber.
function taxaPorForma(forma, parcelas, cfg) {
  const c = cfg || {};
  switch (forma) {
    case 'pix': return num(c.taxa_pix_pct);
    case 'dinheiro': return num(c.taxa_dinheiro_pct);
    case 'debito': return num(c.taxa_debito_pct);
    case 'credito':
      return num(c.taxa_credito_vista_pct)
        + Math.max(0, num(parcelas, 1) - 1) * num(c.taxa_credito_parc_pct);
    case 'carteira': return num(c.taxa_carteira_pct);
    case 'fiado': return num(c.taxa_fiado_pct);
    default: return num(c.taxa_dinheiro_pct);
  }
}

// A faixa é uma ESCADA, e escada se define pelo degrau de baixo.
//
// ── POR QUE NÃO USAR `margem_max` ────────────────────────────────────────
//
// A versão natural seria "a janela que contém a margem": `>= min && < max`.
// Ela tem um defeito que só aparece com os dados reais. Em produção as
// faixas do Bazar Eficaz são:
//
//     Excelente  min 70            Boa       min 50, max 69
//     Atenção    min 30, max 49    Crítica   min  5, max 29
//
// Entre 69 e 70 não existe faixa. Entre 49 e 50 também não. Uma margem de
// 69,5% — excelente — não casa com janela nenhuma e cai no fallback, que é
// a ÚLTIMA faixa: Prejuízo. E Prejuízo tem `bloqueia_venda: true`.
//
// Ou seja: o melhor orçamento do mês apareceria como prejuízo e travaria.
// Medido, não suposto — os quatro vãos são 4,99-5, 29-30, 49-50 e 69-70.
//
// Consertar o DADO (max 69 → 70) resolveria hoje e voltaria a quebrar na
// próxima vez que alguém editasse as faixas. Consertar a REGRA resolve
// sempre: ordena da maior margem para a menor e pega a primeira cujo piso a
// margem alcança. `margem_max` passa a ser decorativo, que é o que ele é.
function encontrarFaixa(margem, faixas) {
  const lista = (faixas && faixas.length ? faixas : FAIXAS_PADRAO)
    .filter((f) => f.ativo !== false);
  if (lista.length === 0) return null;
  const ordenadas = [...lista].sort(
    (a, b) => (b.margem_min ?? -Infinity) - (a.margem_min ?? -Infinity));
  const achada = ordenadas.find(
    (f) => margem >= (f.margem_min == null ? -Infinity : Number(f.margem_min)));
  // Só sobra fallback se TODAS as faixas tiverem piso acima da margem — aí a
  // última (a de piso mais baixo) é mesmo a certa.
  return achada || ordenadas[ordenadas.length - 1] || null;
}

/**
 * @param itens    [{ custo, preco_unitario, quantidade }]
 * @param desconto valor absoluto em R$, não percentual
 */
function avaliar(itens, desconto, forma, parcelas, cfg, faixas) {
  const lista = (itens || []).filter((i) => num(i?.quantidade) > 0);
  const c = cfg || {};

  const totalBruto = lista.reduce((s, i) => s + num(i.preco_unitario) * num(i.quantidade), 0);
  const custoTotal = lista.reduce((s, i) => s + num(i.custo) * num(i.quantidade), 0);
  const totalComDesc = Math.max(0, totalBruto - num(desconto));

  const taxaPagPct = taxaPorForma(forma, parcelas, c);
  const custoTaxaPag = totalComDesc * (taxaPagPct / 100);
  const custoImposto = totalComDesc * (num(c.imposto_pct) / 100);
  const custoOperacional = totalComDesc * (num(c.custo_operacional_pct) / 100);
  const custoComissao = totalComDesc * (num(c.comissao_vendedor_pct) / 100);
  const custoEmbalagem = num(c.custo_embalagem);
  const custoFrete = totalComDesc * (num(c.frete_subsidiado_pct) / 100);

  const custoTotalReal = custoTotal + custoTaxaPag + custoImposto
    + custoOperacional + custoComissao + custoEmbalagem + custoFrete;
  const lucroLiquido = totalComDesc - custoTotalReal;
  const margem = totalComDesc > 0 ? (lucroLiquido / totalComDesc) * 100 : 0;

  const faixa = encontrarFaixa(margem, faixas);
  const descontoMaxPct = num(faixa?.desconto_max_pct);

  // SEM CUSTO a margem sai inflada — o item entra como se fosse lucro puro.
  // Uma faixa inflada liberaria desconto e parcelamento que a venda não
  // sustenta, então quem chama precisa saber e não confiar na faixa.
  const semCusto = lista.some((i) => !(num(i.custo) > 0));

  return {
    totalBruto: Math.round(totalBruto * 100) / 100,
    totalComDesc: Math.round(totalComDesc * 100) / 100,
    custoTotal: Math.round(custoTotal * 100) / 100,
    custoTaxaPag: Math.round(custoTaxaPag * 100) / 100,
    custoTotalReal: Math.round(custoTotalReal * 100) / 100,
    lucroLiquido: Math.round(lucroLiquido * 100) / 100,
    margem: Math.round(margem * 100) / 100,
    taxaPagPct,
    faixa,
    descontoMaxPct,
    descontoMaxValor: Math.round(totalBruto * (descontoMaxPct / 100) * 100) / 100,
    semCusto,
  };
}

/**
 * Teto de parcelas que a faixa permite, para `parcelasSugeridas`.
 *
 * `null` quer dizer "a faixa não opina" — e é o que se devolve quando falta
 * custo, porque aí a margem é ficção e a faixa que saiu dela também.
 */
function tetoDeParcelasDaFaixa(avaliacao) {
  if (!avaliacao || avaliacao.semCusto) return null;
  const f = avaliacao.faixa;
  if (!f) return null;
  if (f.permite_parcelamento === false) return 1;
  const max = Number(f.max_parcelas);
  return Number.isFinite(max) && max >= 1 ? Math.floor(max) : null;
}

module.exports = { FAIXAS_PADRAO, taxaPorForma, encontrarFaixa, avaliar, tetoDeParcelasDaFaixa };

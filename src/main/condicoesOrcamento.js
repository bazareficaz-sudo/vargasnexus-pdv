// CONDIÇÕES COMERCIAIS DO ORÇAMENTO.
//
// Espelha `pdv-vargas-web/src/lib/orcamentos/condicoes.ts`. O mesmo texto
// serve para o papel e para o WhatsApp — se fossem dois lugares, um sairia
// desatualizado do outro e o cliente receberia uma condição na conversa e
// outra no papel.
//
// ── O PROBLEMA QUE ISTO ATACA ────────────────────────────────────────────
//
// Medido em produção: 72 orçamentos em 12 meses, 69 ainda "aberto", ticket
// médio R$ 246,43. O vendedor imprime, entrega o papel, e o papel não diz
// nada além dos itens e do total. O cliente leva para comparar com uma loja
// que escreveu "3x sem juros" no dela.
//
// ── A ESTRATÉGIA ─────────────────────────────────────────────────────────
//
// Produto em promoção sai pelo preço CHEIO, e a promoção reaparece como
// desconto à vista. Não é desconto novo: é o preço da prateleira, dito de um
// jeito que vira argumento. A conta fecha porque `totalAvista(totalCheio)`
// cai exatamente no total praticado.
//
// Ligada em `saude_config.orcamento_promo_vira_desconto`, que no Bazar
// Eficaz já está ligada com formas `pix, dinheiro`.

const FORMA_AVISTA_LABEL = {
  pix: 'Pix',
  dinheiro: 'dinheiro',
  debito: 'cartão de débito',
  transferencia: 'transferência',
};

const brl = (v) => Number(v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Arredonda a duas casas sem o erro de ponto flutuante do `toFixed`. */
function cent(v) {
  return Math.round(Number(v ?? 0) * 100) / 100;
}

function totalAvista(total, c) {
  const pct = Number(c?.descontoAvistaPct ?? 0);
  if (!(pct > 0)) return cent(total);
  return cent(Number(total ?? 0) * (1 - pct / 100));
}

function temCondicoes(c) {
  return Number(c?.descontoAvistaPct ?? 0) > 0
    || Number(c?.parcelasMax ?? 0) > 1
    || !!String(c?.observacao ?? '').trim();
}

// ── Promoção virando desconto à vista ───────────────────────
//
// Com vários itens o percentual é a média PONDERADA — quanto a soma
// promocional representa de desconto sobre a soma cheia. Média simples
// mentiria: 10% num item de R$ 1.000 e 50% num de R$ 10 não é 30%.
function calcularVitrinePromo(itens) {
  let totalCheio = 0;
  let totalPraticado = 0;
  for (const i of itens || []) {
    const q = Number(i?.quantidade ?? 0);
    // Preço cheio MENOR que o praticado não é promoção — é tabela
    // desatualizada ou negociação para cima. Sem este `max`, apareceria um
    // "desconto negativo" na tela.
    const cheio = Math.max(Number(i?.precoCheio ?? 0), Number(i?.precoPraticado ?? 0));
    totalCheio += cheio * q;
    totalPraticado += Number(i?.precoPraticado ?? 0) * q;
  }
  const bruto = totalCheio > 0 ? (1 - totalPraticado / totalCheio) * 100 : 0;
  return {
    totalCheio: cent(totalCheio),
    totalPraticado: cent(totalPraticado),
    // Duas casas: com centavos, arredondar para inteiro faria o valor à
    // vista não bater com o total praticado.
    descontoPct: Math.round(bruto * 100) / 100,
    temPromo: bruto > 0.005,
  };
}

// ── Parcelamento sugerido ───────────────────────────────────
//
// A regra é a PARCELA, não o número de vezes: `floor(total / mínima)`.
//
//     R$  80 → 1x   (não alcança a mínima: some sozinho)
//     R$ 100 → 2x de R$ 50,00
//     R$ 150 → 3x de R$ 50,00
//
// DOIS TETOS, e vence o MENOR: o da empresa e o da faixa de saúde deste
// orçamento. O da faixa manda porque parcelar custa de verdade — a taxa de
// crédito é `vista + (n-1) × parcelado`, então 3x sai por 8% da venda com as
// taxas do Bazar Eficaz.
//
// Devolve 1 quando não há parcelamento a oferecer, e 1 não é "1x no cartão":
// é "só à vista". Quem exibe decide se mostra a linha.
function parcelasSugeridas(total, { parcelaMinima, teto, tetoFaixa } = {}) {
  const t = Number(total ?? 0);
  const minima = Number(parcelaMinima ?? 0);
  if (!(t > 0) || !(minima > 0)) return 1;
  const limites = [Math.floor(t / minima), Math.floor(Number(teto ?? 1))];
  if (tetoFaixa != null) limites.push(Math.floor(Number(tetoFaixa)));
  const validos = limites.filter((n) => Number.isFinite(n));
  return Math.max(1, Math.min(...validos));
}

/** As condições em frases curtas — usadas na tela, no papel e no zap. */
function linhasCondicoes(total, c) {
  const linhas = [];
  const pct = Number(c?.descontoAvistaPct ?? 0);

  if (pct > 0) {
    const formas = (c.avistaFormas || []).length > 0
      ? c.avistaFormas.map((f) => FORMA_AVISTA_LABEL[f] ?? f).join(' ou ')
      : 'à vista';
    const economia = cent(Number(total ?? 0) - totalAvista(total, c));
    linhas.push(
      `À vista em ${formas}: ${brl(totalAvista(total, c))}`
      + ` (${pct}% de desconto — você economiza ${brl(economia)})`);
  }

  const n = Number(c?.parcelasMax ?? 0);
  if (n > 1) {
    linhas.push(`Ou em até ${n}x de ${brl(cent(Number(total ?? 0) / n))}`
      + (c.parcelasSemJuros ? ' sem juros' : ''));
  }

  const obs = String(c?.observacao ?? '').trim();
  if (obs) linhas.push(obs);
  return linhas;
}

// ── O aviso que a tela precisa dar ──────────────────────────
//
// Regra do lojista: desconto manual DESCONSIDERA a promoção e vale sozinho.
// Isso abre um buraco: se o manual for MENOR que a promoção, o papel oferece
// à vista um preço PIOR do que o cliente pagaria no balcão hoje.
//
// Com 10% de promoção nos itens, digitar 5% manual faz o orçamento trabalhar
// contra a loja. Avisa, não bloqueia — pode haver motivo.
function avisoDescontoManual(manualPct, promoPct) {
  const manual = Number(manualPct ?? 0);
  const promo = Number(promoPct ?? 0);
  if (!(manual > 0) || !(promo > 0)) return null;
  if (manual >= promo) return null;
  return `A promoção destes itens já vale ${promo}% à vista. `
    + `Um desconto manual de ${manual}% deixa o preço do orçamento PIOR `
    + `do que o cliente pagaria hoje no balcão.`;
}

/** Mensagem pronta para o WhatsApp. Asteriscos são o negrito de lá. */
function montarMensagemOrcamento(d) {
  const partes = [];
  partes.push(`*Orçamento #${d.numero}*${d.empresaNome ? ` — ${d.empresaNome}` : ''}`);
  if (d.clienteNome) partes.push(`Para: ${d.clienteNome}`);
  partes.push('');

  // Acima de 20 itens vira parede de texto no celular.
  const LIMITE = 20;
  const itens = d.itens || [];
  for (const i of itens.slice(0, LIMITE)) {
    partes.push(`• ${i.quantidade}x ${i.produto_nome} — ${brl(i.total)}`);
  }
  if (itens.length > LIMITE) partes.push(`• ...e mais ${itens.length - LIMITE} item(ns)`);

  partes.push('');
  partes.push(`*Total: ${brl(d.total)}*`);

  const cond = linhasCondicoes(d.total, d.condicoes);
  if (cond.length > 0) {
    partes.push('');
    partes.push('*Condições de pagamento*');
    for (const l of cond) partes.push(`✅ ${l}`);
  }

  if (d.validade) {
    partes.push('');
    partes.push(`Válido até ${new Date(d.validade + 'T00:00:00').toLocaleDateString('pt-BR')}.`);
  }
  return partes.join('\n');
}

module.exports = {
  FORMA_AVISTA_LABEL,
  totalAvista,
  temCondicoes,
  calcularVitrinePromo,
  parcelasSugeridas,
  linhasCondicoes,
  avisoDescontoManual,
  montarMensagemOrcamento,
};

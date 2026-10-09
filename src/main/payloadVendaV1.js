/**
 * payloadVendaV1.js — o contrato da venda transacional (FASE 0.6D.3).
 *
 * Traduz a venda do SQLite para o payload que `sincronizar_venda_pdv_v1`
 * espera. Função PURA: nada de rede, nada de banco, nada de store. É o que
 * permite testá-la contra todos os formatos de venda sem subir nada.
 *
 * O CONTRATO FOI LIDO DA FUNÇÃO REAL EM PRODUÇÃO, não do relatório da
 * 0.6D.2 — `pg_get_functiondef` mostra exatamente quais campos ela lê.
 *
 * A REGRA QUE SUSTENTA A IDEMPOTÊNCIA: o mesmo estado local tem de produzir
 * o mesmo payload, sempre. Duas consequências práticas:
 *
 *   1. `id` de cada item vem do SQLite (`venda_itens.id`), gerado UMA vez
 *      na transação de `vendas.registrar`. Nunca gerar aqui: um uuid novo a
 *      cada tentativa mudaria o fingerprint e transformaria retry em
 *      conflito;
 *   2. nada de `Date.now()`, nada de valor derivado do relógio. `created_at`
 *      vem da venda gravada.
 */

'use strict';

const SCHEMA_VERSION = 1;
const SCHEMA_VERSION_PAGAMENTOS = 2;

// A carteira NAO vai em v2 enquanto o gatilho da parte B nao existir.
//
// `criar_conta_carteira` dispara no INSERT da venda lendo NEW.pagamentos; em
// v2 os pagamentos chegam depois, entao a conta a receber nao nasceria. O
// servidor recusa esse payload — e recusa certo. Mas travar a venda em
// conflito seria pior que nao compor: aqui a venda com carteira cai para v1
// e sincroniza exatamente como sempre sincronizou.
const FORMAS_SEM_V2 = ['carteira'];

// O servidor confere o formato; mandar lixo só gera ida e volta. `_comoUuid`
// existe em api.js pelo mesmo motivo — aqui é local para a função ficar pura.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const comoUuid = (v) => (typeof v === 'string' && UUID_RE.test(v) ? v : null);

const texto = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const numero = (v, padrao = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
};

/**
 * @param {object} venda  linha de `vendas` + `venda.itens` (como `db.vendas.getById` devolve)
 * @param {object} ctx    { empresaId, empresaFiscalId, depositoId, terminalId, operadorNome }
 * @returns {{ok: true, payload: object} | {ok: false, erro: string}}
 */
function montarPayloadVendaV1(venda, ctx = {}) {
  if (!venda || !comoUuid(venda.id)) {
    return { ok: false, erro: 'venda sem id em formato uuid' };
  }

  const empresaId = comoUuid(ctx.empresaId || venda.empresa_id);
  if (!empresaId) return { ok: false, erro: 'empresa_id ausente ou não é uuid' };

  const itens = [];
  for (const i of venda.itens || []) {
    // Sem id estável não há idempotência de item nem de movimento de
    // estoque. O servidor recusa o payload inteiro; melhor recusar aqui,
    // com mensagem que diz onde olhar.
    if (!comoUuid(i.id)) {
      return { ok: false, erro: `item sem id em formato uuid (produto "${i.produto_nome || '?'}")` };
    }
    itens.push({
      id: i.id,
      // Mesma regra do legado: NUNCA usar o id local do produto como
      // fallback. Um uuid que parece válido e não existe no Supabase criaria
      // item órfão. Nulo aqui é tratado pelo servidor como "sem produto
      // vinculado", e o estoque daquele item não é mexido.
      produto_id: comoUuid(i.produto_remote_id),
      produto_nome: texto(i.produto_nome),
      produto_sku: texto(i.produto_sku),
      quantidade: numero(i.quantidade),
      preco_unitario: numero(i.preco_unitario),
      desconto: numero(i.desconto),
      total: numero(i.total),
    });
  }

  // ── composicao de pagamentos (v2) ─────────────────────────────
  //
  // So entra quando o chamador pede E a venda tem composicao local E
  // nenhuma parcela é de uma forma ainda nao suportada. Sem isso, o payload
  // sai exatamente como sempre saiu: v1, sem o campo `pagamentos`.
  const locais = Array.isArray(venda.pagamentos) ? venda.pagamentos : [];
  const podeV2 = ctx.pagamentosV2 === true
    && locais.length > 0
    && locais.every(p => p && comoUuid(p.id) && !FORMAS_SEM_V2.includes(p.forma));

  const pagamentos = podeV2 ? locais.map(p => ({
    id: p.id,
    forma: texto(p.forma),
    valor: numero(p.valor),
    // Entregue e troco so existem em especie, e so quando a UI informou.
    // `null` é a ausencia; nao vira zero.
    valor_entregue: p.valor_entregue == null ? null : numero(p.valor_entregue),
    troco: p.troco == null ? null : numero(p.troco),
    sequencia: p.sequencia == null ? 1 : numero(p.sequencia, 1),
  })) : null;

  const payload = {
    schema_version: pagamentos ? SCHEMA_VERSION_PAGAMENTOS : SCHEMA_VERSION,

    // ── identidade ────────────────────────────────────────────────
    venda_id: venda.id,
    empresa_id: empresaId,
    empresa_fiscal_id: comoUuid(ctx.empresaFiscalId) || empresaId,
    // É o id do SERVIDOR, nunca o do SQLite — mesma regra da arbitragem
    // (ver `orcamentos.getById`). Nulo em venda comum.
    orcamento_id: comoUuid(venda.orcamento_remote_id),

    // ── comerciais ────────────────────────────────────────────────
    numero: venda.numero ?? null,
    subtotal: numero(venda.subtotal),
    desconto: numero(venda.desconto),
    total: numero(venda.total),
    status: texto(venda.status) || 'concluida',

    // ── pagamento ─────────────────────────────────────────────────
    forma_pagamento: texto(venda.forma_pagamento),
    valor_pago: numero(venda.valor_pago ?? venda.total),
    troco: numero(venda.troco),

    // ── cliente ───────────────────────────────────────────────────
    cliente_id: comoUuid(venda.cliente_remote_id),
    cliente_nome: texto(venda.cliente_nome),

    // ── origem ────────────────────────────────────────────────────
    deposito_id: comoUuid(ctx.depositoId || venda.deposito_id),
    terminal_id: texto(ctx.terminalId),
    operador_nome: texto(ctx.operadorNome || venda.operador_nome),
    vendedor_id: comoUuid(venda.vendedor_id),
    vendedor_nome: texto(venda.vendedor_nome),
    vendedor_codigo: texto(venda.vendedor_codigo),
    observacao: texto(venda.observacao),
    created_at: texto(venda.created_at),

    itens,
  };

  // Campo ausente em v1, nunca `[]`: o servidor distingue "sem composicao"
  // de "composicao vazia", e um array vazio seria recusado.
  if (pagamentos) payload.pagamentos = pagamentos;

  return { ok: true, payload };
}

module.exports = { montarPayloadVendaV1, SCHEMA_VERSION, SCHEMA_VERSION_PAGAMENTOS, FORMAS_SEM_V2 };

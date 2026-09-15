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

  const payload = {
    schema_version: SCHEMA_VERSION,

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

  return { ok: true, payload };
}

module.exports = { montarPayloadVendaV1, SCHEMA_VERSION };

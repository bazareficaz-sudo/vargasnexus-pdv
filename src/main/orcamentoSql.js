/**
 * orcamentoSql.js — o SQL de reconciliação do orçamento, num lugar só.
 *
 * ── POR QUE ISTO EXISTE ─────────────────────────────────────────────────
 *
 * Estas duas instruções decidem o que o servidor consegue corrigir no estado
 * local. Elas estavam dentro de `database.js`, que só carrega dentro do
 * Electron (better-sqlite3 é compilado para o ABI dele). Resultado prático:
 * nenhum teste jamais executou este SQL — e foi exatamente aqui que o número
 * oficial se perdia, porque `confirmarSincronizacao` não gravava `numero`.
 *
 * Isoladas, elas rodam contra um SQLite real em `node --test`, pelo módulo
 * `node:sqlite`. O teste exercita a MESMA string que o app executa, não uma
 * cópia parecida.
 *
 * ── A REGRA DE AUTORIDADE ───────────────────────────────────────────────
 *
 * O `numero` é comercial e nasce no servidor (`nextval`). O que o cliente
 * calcula antes de sincronizar (`MAX(numero)+1`) é PROVISÓRIO: um palpite
 * para a tela não ficar vazia. Depois da confirmação, o número do servidor
 * é o número — e o palpite não pode mais ser referência.
 *
 * As três identidades continuam separadas e nenhuma delas é o número:
 *
 *     id         local, estável, nunca reescrito
 *     remote_id  como o servidor conhece o documento
 *     numero     referência comercial, do servidor
 */

/**
 * Aceita só o que pode ser número oficial. Devolve `null` para o resto, e
 * `null` em COALESCE preserva o valor que já está gravado.
 *
 * `Number(null) === 0` — foi assim que `revisao_base: null` passou por uma
 * validação frouxa na 0.6C. Aqui a checagem é de inteiro positivo, não de
 * "conversível para número".
 */
function numeroOficial(n) {
  const v = typeof n === 'string' ? Number(n) : n;
  return Number.isInteger(v) && v > 0 ? v : null;
}

// Confirmação vinda da rota autenticada (ou do legado, que também devolve o
// número que o servidor gravou). COALESCE em toda coluna que o servidor pode
// não ter informado: confirmar uma edição não pode apagar o que já estava.
const SQL_CONFIRMAR_SINCRONIZACAO = `
  UPDATE orcamentos
     SET remote_id    = COALESCE(?, remote_id),
         revisao_base = COALESCE(?, revisao_base),
         numero       = COALESCE(?, numero),
         sync_status  = 'synced',
         synced_at    = ?,
         op_chave     = NULL,
         conflito_em  = NULL
   WHERE id = ?
`;

function paramsConfirmar(id, { remote_id, revisao, numero } = {}, agora) {
  return [
    remote_id || null,
    revisao == null ? null : Number(revisao),
    numeroOficial(numero),
    agora,
    id,
  ];
}

// Down-sync: o servidor manda o cabeçalho, o local se alinha.
//
// ON CONFLICT(id) — e o `id` do cloud é o id do servidor. Para os documentos
// nascidos na rota nova as duas identidades são a mesma, então casa. Para os
// nascidos no legado NÃO casa, e a inserção esbarra em UNIQUE(remote_id) —
// esse é o defeito do nº58, DÍVIDA SEPARADA, deliberadamente não tocada aqui.
//
// `numero` entra no DO UPDATE pelo mesmo motivo do UPDATE acima: o servidor
// é a autoridade. `WHERE sync_status = 'synced'` continua protegendo edição
// local ainda não enviada — o cloud não sobrescreve o que está pendente.
const SQL_UPSERT_DOWNSYNC = `
  INSERT INTO orcamentos
    (id, remote_id, numero, status, cliente_id, cliente_nome, cliente_telefone,
     vendedor_nome, forma_pagamento, validade_dias, subtotal, desconto, total,
     observacao, created_at, synced_at, sync_status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
  ON CONFLICT(id) DO UPDATE SET
    numero          = COALESCE(excluded.numero, orcamentos.numero),
    status          = excluded.status,
    cliente_nome    = excluded.cliente_nome,
    cliente_telefone= excluded.cliente_telefone,
    total           = excluded.total,
    synced_at       = excluded.synced_at,
    sync_status     = 'synced'
  WHERE sync_status = 'synced'
`;

// `undefined` nao e um valor ligavel em SQLite: tanto better-sqlite3 quanto
// node:sqlite recusam. Toda coluna sai daqui como null, numero ou texto.
function paramsUpsert(o, agora) {
  return [
    o.id, o.remote_id || null, numeroOficial(o.numero), o.status || 'aberto',
    o.cliente_id || null, o.cliente_nome || null, o.cliente_telefone || null,
    o.vendedor_nome || null, o.forma_pagamento || null, o.validade_dias || 7,
    o.subtotal || 0, o.desconto || 0, o.total || 0,
    o.observacao || null, o.created_at || agora, agora,
  ];
}

module.exports = {
  numeroOficial,
  SQL_CONFIRMAR_SINCRONIZACAO, paramsConfirmar,
  SQL_UPSERT_DOWNSYNC, paramsUpsert,
};

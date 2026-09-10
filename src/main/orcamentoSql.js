/**
 * orcamentoSql.js — o SQL de reconciliação do orçamento, num lugar só.
 *
 * ── POR QUE ISTO EXISTE ─────────────────────────────────────────────────
 *
 * Estas instruções decidem o que o servidor consegue corrigir no estado
 * local. Elas estavam dentro de `database.js`, que só carrega dentro do
 * Electron (better-sqlite3 é compilado para o ABI dele). Resultado prático:
 * nenhum teste jamais executou este SQL — e foi exatamente aqui que o número
 * oficial se perdia, porque `confirmarSincronizacao` não gravava `numero`.
 *
 * Isoladas, elas rodam contra um SQLite real em `node --test`, pelo módulo
 * `node:sqlite`. O teste exercita a MESMA string que o app executa, não uma
 * cópia parecida — e, desde a 0.6C.3, a mesma FUNÇÃO.
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

// ─── SUBIDA: o servidor confirmou ────────────────────────────────────────
//
// COALESCE em toda coluna que o servidor pode não ter informado: confirmar
// uma edição não pode apagar o que já estava.
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

// ─── DESCIDA: o cloud manda o cabeçalho ──────────────────────────────────
//
// ── O DEFEITO CORRIGIDO NA 0.6C.3 ───────────────────────────────────────
//
// A descida era um `INSERT ... ON CONFLICT(id) DO UPDATE`. Só que a tabela
// local tem DUAS colunas de identidade — `id` (PK) e `remote_id` (UNIQUE) —
// e o id que desce do servidor pode estar guardado no `remote_id` de uma
// linha cujo `id` é outro. É o caso de todo orçamento nascido no legado:
//
//     local    id = d87547a7…   remote_id = ee29e3b9…
//     cloud    id = ee29e3b9…
//
// `ON CONFLICT(id)` procura a PK `ee29e3b9…`, não acha, e o comando vira
// INSERT — que esbarra em `remote_id UNIQUE`, já ocupado por `d87547a7…`.
// Medido: a falha caía no item 2 de 56, e o rollback levava os outros 54
// junto. O erro se repetiu a cada ciclo de sync desde 08/09/2026.
//
// A correção é resolver a IDENTIDADE antes de escrever, com a mesma regra
// que o resto do sistema usa (`remote_id ?? id`), e então UPDATE ou INSERT.
// Nenhuma linha histórica é recriada, nenhum `id` local muda.
//
// ── O QUE A DESCIDA PODE E NÃO PODE ESCREVER ────────────────────────────
//
// Regra: NÃO SE ESCREVE COLUNA QUE O PAYLOAD NÃO CONSEGUE EXPRESSAR.
//
//   `status`            a consulta do down-sync filtra `status IN ('aberto')`,
//                       então TODA linha que desce tem status 'aberto'. A
//                       coluna não carrega informação nenhuma — escrevê-la só
//                       pode transformar o 'pendente' local (que dá botão de
//                       editar, converter e cancelar) num 'aberto' que não dá.
//   `cliente_telefone`  o mapeamento remoto devolve `null` fixo. Escrever só
//                       poderia apagar o telefone local.
//   `revisao_base`      o servidor tem `revisao`, mas a descida traz só o
//                       CABEÇALHO. Adotar a revisão sem os itens deixaria
//                       este terminal declarar que partiu de um estado que
//                       ele não tem — e sobrescrever, na próxima edição, os
//                       itens de outro terminal. É a perda silenciosa que
//                       esta fase inteira existe para remover. Fica de fora,
//                       de propósito: com a revisão velha, a próxima edição
//                       leva 409 e PARA, que é o desfecho correto.
const SQL_LOCALIZAR_DO_CLOUD = `
  SELECT id, remote_id, sync_status
    FROM orcamentos
   WHERE remote_id = ? OR id = ?
   ORDER BY (remote_id = ?) DESC
   LIMIT 1
`;

const SQL_ATUALIZAR_DO_CLOUD = `
  UPDATE orcamentos
     SET numero       = COALESCE(?, numero),
         cliente_nome = ?,
         total        = ?,
         synced_at    = ?
   WHERE id = ?
`;

const SQL_INSERIR_DO_CLOUD = `
  INSERT INTO orcamentos
    (id, remote_id, numero, status, cliente_id, cliente_nome, cliente_telefone,
     vendedor_nome, forma_pagamento, validade_dias, subtotal, desconto, total,
     observacao, created_at, synced_at, sync_status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced')
`;

// `undefined` não é um valor ligável em SQLite: tanto better-sqlite3 quanto
// node:sqlite recusam. Toda coluna sai daqui como null, número ou texto.
function paramsInserirDoCloud(o, agora) {
  return [
    o.id, o.remote_id || o.id, numeroOficial(o.numero), o.status || 'aberto',
    o.cliente_id || null, o.cliente_nome || null, o.cliente_telefone || null,
    o.vendedor_nome || null, o.forma_pagamento || null, o.validade_dias || 7,
    o.subtotal || 0, o.desconto || 0, o.total || 0,
    o.observacao || null, o.created_at || agora, agora,
  ];
}

function paramsAtualizarDoCloud(o, agora, idLocal) {
  return [numeroOficial(o.numero), o.cliente_nome || null, o.total || 0, agora, idLocal];
}

/**
 * Aplica o lote que desceu do servidor, uma linha por vez.
 *
 * ── POR QUE NÃO É MAIS UMA TRANSAÇÃO SÓ ─────────────────────────────────
 *
 * Era, e uma única linha problemática abortava as outras 55 — por dias.
 * O all-or-nothing não comprava nada aqui: esta descida é REFRESCO DE CACHE
 * de cabeçalho, não operação de negócio. Aplicar metade não deixa o banco
 * inconsistente; o ciclo seguinte reaplica o resto. O que o all-or-nothing
 * comprava era um modo de falha catastrófico.
 *
 * Cada linha vai num SAVEPOINT: se falhar, desfaz só a dela, o erro é
 * CONTADO e devolvido, e as demais seguem. Silêncio não é desfecho.
 *
 * `db` precisa só de `prepare()` e `exec()` — a interseção entre
 * better-sqlite3 (o app) e node:sqlite (os testes). É por isso que o teste
 * consegue rodar esta função, e não uma imitação dela.
 */
function reconciliarDoCloud(db, lista, agora) {
  const localizar = db.prepare(SQL_LOCALIZAR_DO_CLOUD);
  const atualizar = db.prepare(SQL_ATUALIZAR_DO_CLOUD);
  const inserir = db.prepare(SQL_INSERIR_DO_CLOUD);

  const r = { total: 0, inseridos: 0, atualizados: 0, preservados: 0, falhas: [] };

  for (const o of lista || []) {
    r.total++;
    db.exec('SAVEPOINT orc_down');
    try {
      const idRemoto = o.id;
      const local = localizar.get(idRemoto, idRemoto, idRemoto);
      if (!local) {
        inserir.run(...paramsInserirDoCloud(o, agora));
        r.inseridos++;
      } else if (local.sync_status !== 'synced') {
        // Edição local ainda não subiu. O cloud não atropela o que está a
        // caminho — proteção que já existia na cláusula WHERE antiga e que
        // agora fica visível na contagem, em vez de virar um UPDATE mudo.
        r.preservados++;
      } else {
        atualizar.run(...paramsAtualizarDoCloud(o, agora, local.id));
        r.atualizados++;
      }
      db.exec('RELEASE orc_down');
    } catch (e) {
      db.exec('ROLLBACK TO orc_down');
      db.exec('RELEASE orc_down');
      r.falhas.push({ id: o.id, numero: o.numero, erro: e.message });
    }
  }
  return r;
}

module.exports = {
  numeroOficial,
  SQL_CONFIRMAR_SINCRONIZACAO, paramsConfirmar,
  SQL_LOCALIZAR_DO_CLOUD, SQL_ATUALIZAR_DO_CLOUD, SQL_INSERIR_DO_CLOUD,
  paramsInserirDoCloud, paramsAtualizarDoCloud,
  reconciliarDoCloud,
};

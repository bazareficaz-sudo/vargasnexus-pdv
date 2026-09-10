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
// Sem LIMIT: a contagem de correspondencias E a informacao. Zero linhas
// significa documento novo, uma linha significa identidade resolvida, e DUAS
// OU MAIS significam que o estado local nao consegue dizer quem e o documento
// — ver `reconciliarDoCloud`.
const SQL_LOCALIZAR_DO_CLOUD = `
  SELECT id, remote_id, numero, status, sync_status, op_chave
    FROM orcamentos
   WHERE remote_id = ? OR id = ?
   ORDER BY id
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

  const r = {
    total: 0, inseridos: 0, atualizados: 0, preservados: 0,
    ambiguos: 0, ambiguidades: [], falhas: [],
  };

  for (const o of lista || []) {
    r.total++;
    db.exec('SAVEPOINT orc_down');
    try {
      const idRemoto = o.id;
      const encontrados = localizar.all(idRemoto, idRemoto);

      if (encontrados.length > 1) {
        // IDENTIDADE AMBIGUA — duas ou mais linhas locais dizem ser este
        // documento. Isso so acontece com o historico ja corrompido, e a
        // correcao NAO E DESTA CAMADA: escolher uma seria transformar uma
        // corrupcao possivel numa decisao automatica invisivel.
        //
        // Nada e apagado, fundido, recriado ou alterado. A linha do lote sai
        // preservada e o caso vai INTEIRO para quem chamou poder registrar.
        r.ambiguos++;
        r.ambiguidades.push({
          motivo: 'identidade_ambigua',
          cloud_id: idRemoto,
          numero_cloud: o.numero ?? null,
          ids_locais: encontrados.map((l) => l.id),
          remote_ids_locais: encontrados.map((l) => l.remote_id),
          numeros_locais: encontrados.map((l) => l.numero),
        });
        db.exec('RELEASE orc_down');
        continue;
      }

      const local = encontrados[0];
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

// ─── DESCIDA B: CANCELAMENTO ─────────────────────────────────────────────
//
// ── A LACUNA (0.6C.4) ───────────────────────────────────────────────────
//
// A descida A busca `status IN ('aberto')`. Um orcamento cancelado no
// servidor simplesmente PARA DE DESCER — nao chega nenhuma noticia dele. Se
// este terminal ja tinha o documento, a linha local fica 'aberto' para sempre
// e a tela segue oferecendo editar, converter em venda e cancelar de novo,
// sobre um documento que nao existe mais como ativo.
//
// Cancelamento e ESTADO TERMINAL, nao exclusao: nada e apagado, nada e
// recriado, o historico continua visivel.
//
// ── POR QUE SO O `status` E ESCRITO ─────────────────────────────────────
//
// A mesma regra da 0.6C.3: nao se escreve coluna que o payload nao consegue
// expressar. O tombstone diz UMA coisa — "este documento foi cancelado". Nao
// traz itens, nao traz a revisao correspondente, nao traz cabecalho novo.
// Entao numero, total, revisao_base, id, remote_id e itens ficam intactos.
//
// ── O VOCABULARIO ───────────────────────────────────────────────────────
//
// Servidor e Electron NAO usam as mesmas palavras: 'aberto' no servidor
// corresponde a 'pendente' aqui, e foi por confundir os dois que a 0.6C.3
// parou de escrever `status` na descida A. 'cancelado' e a UNICA palavra que
// as duas pontas usam com o mesmo sentido — e por isso a traducao e explicita
// e cobre so ela.
const STATUS_REMOTO_PARA_LOCAL = { cancelado: 'cancelado' };

const SQL_MARCAR_CANCELADO = `
  UPDATE orcamentos
     SET status = ?, synced_at = ?
   WHERE id = ?
`;

// Conflito: existe operacao local pendente sobre um documento que o servidor
// ja cancelou. NAO se resolve automaticamente — nem apagando a operacao, nem
// sobrescrevendo, nem marcando como sincronizado. `conflito_em` e a estrutura
// que ja existe para "olhe este documento"; e escrito UMA vez, e nada mais na
// linha e tocado. Em particular `op_chave` SOBREVIVE: e ela que garante que a
// operacao local, quando subir, nao vire um segundo efeito.
const SQL_MARCAR_CONFLITO_DE_CANCELAMENTO = `
  UPDATE orcamentos
     SET conflito_em = ?
   WHERE id = ? AND conflito_em IS NULL
`;

/**
 * Aplica os tombstones de cancelamento, um por vez.
 *
 * Mesma disciplina da descida A: identidade resolvida antes de escrever,
 * ambiguidade nunca resolvida em silencio, SAVEPOINT por linha, resumo
 * contado e devolvido.
 */
function aplicarCancelamentosDoCloud(db, lista, agora) {
  const localizar = db.prepare(SQL_LOCALIZAR_DO_CLOUD);
  const cancelar = db.prepare(SQL_MARCAR_CANCELADO);
  const marcarConflito = db.prepare(SQL_MARCAR_CONFLITO_DE_CANCELAMENTO);

  const r = {
    total: 0, aplicados: 0, ja_cancelados: 0, desconhecidos: 0,
    conflitos: [], ambiguos: 0, ambiguidades: [], falhas: [],
  };

  for (const o of lista || []) {
    r.total++;
    db.exec('SAVEPOINT orc_cancel');
    try {
      const encontrados = localizar.all(o.id, o.id);

      if (encontrados.length > 1) {
        r.ambiguos++;
        r.ambiguidades.push({
          motivo: 'identidade_ambigua',
          cloud_id: o.id,
          numero_cloud: o.numero ?? null,
          ids_locais: encontrados.map((l) => l.id),
          remote_ids_locais: encontrados.map((l) => l.remote_id),
          numeros_locais: encontrados.map((l) => l.numero),
        });
      } else if (encontrados.length === 0) {
        // Documento que este terminal nunca teve. Um tombstone NAO cria
        // documento: registrar um cancelamento de algo que nunca existiu aqui
        // seria inventar historico.
        r.desconhecidos++;
      } else {
        const local = encontrados[0];
        const alvo = STATUS_REMOTO_PARA_LOCAL[o.status || 'cancelado'];
        if (!alvo) {
          r.desconhecidos++;                       // status que nao traduzimos
        } else if (local.status === alvo) {
          r.ja_cancelados++;                       // idempotente: nada a fazer
        } else if (local.sync_status !== 'synced' || local.op_chave) {
          marcarConflito.run(agora, local.id);
          r.conflitos.push({
            motivo: 'operacao_local_pendente',
            id_local: local.id, remote_id: local.remote_id,
            numero: local.numero, status_local: local.status,
            sync_status: local.sync_status, tem_op_chave: !!local.op_chave,
          });
        } else {
          cancelar.run(alvo, agora, local.id);
          r.aplicados++;
        }
      }
      db.exec('RELEASE orc_cancel');
    } catch (e) {
      db.exec('ROLLBACK TO orc_cancel');
      db.exec('RELEASE orc_cancel');
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
  STATUS_REMOTO_PARA_LOCAL, SQL_MARCAR_CANCELADO,
  SQL_MARCAR_CONFLITO_DE_CANCELAMENTO, aplicarCancelamentosDoCloud,
};

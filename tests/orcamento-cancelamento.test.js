const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const orcSql = require('../src/main/orcamentoSql');
const Acoes = require('../src/renderer/lib/acoesOrcamento');

// FASE 0.6C.4 — PROPAGAÇÃO DE CANCELAMENTO.
//
// A descida de ativos busca `status IN ('aberto')`. Um orçamento cancelado no
// servidor simplesmente PARA DE DESCER: não chega nenhuma notícia dele. O
// terminal que já tinha o documento fica com a linha local 'aberto' para
// sempre, e a tela segue oferecendo editar, converter em venda e cancelar de
// novo sobre um documento que o servidor considera encerrado.
//
// Cancelamento aqui é ESTADO TERMINAL, não exclusão: nada é apagado, nada é
// recriado, o documento continua no histórico.
//
// Como na 0.6C.3, estes testes executam a MESMA FUNÇÃO que o app executa.

const DDL = `
CREATE TABLE orcamentos (
  id TEXT PRIMARY KEY,
  remote_id TEXT UNIQUE,
  numero INTEGER,
  status TEXT DEFAULT 'pendente',
  cliente_id TEXT, cliente_nome TEXT, cliente_telefone TEXT,
  vendedor_nome TEXT, forma_pagamento TEXT DEFAULT 'dinheiro',
  validade_dias INTEGER DEFAULT 7,
  subtotal REAL NOT NULL DEFAULT 0, desconto REAL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
  observacao TEXT, created_at TEXT NOT NULL, synced_at TEXT,
  sync_status TEXT DEFAULT 'pending',
  revisao_base INTEGER DEFAULT 0, conflito_em TEXT, op_chave TEXT
);
CREATE TABLE orcamento_itens (
  id TEXT PRIMARY KEY, orcamento_id TEXT, produto_id TEXT,
  produto_nome TEXT, produto_sku TEXT,
  quantidade REAL, preco_unitario REAL, desconto REAL, total REAL
);
CREATE TABLE sync_queue (
  id TEXT PRIMARY KEY, entidade TEXT, operacao TEXT, payload TEXT,
  tentativas INTEGER DEFAULT 0, erro TEXT, created_at TEXT, processado INTEGER DEFAULT 0
);
`;

function banco(arquivo = ':memory:') {
  const sq = new DatabaseSync(arquivo);
  sq.exec(DDL);
  return sq;
}

function local(sq, o) {
  sq.prepare(`INSERT INTO orcamentos
    (id, remote_id, numero, status, sync_status, revisao_base, op_chave, conflito_em,
     cliente_nome, forma_pagamento, subtotal, desconto, total, created_at, synced_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    o.id, o.remote_id ?? null, o.numero ?? null, o.status ?? 'pendente',
    o.sync_status ?? 'synced', o.revisao_base ?? 0, o.op_chave ?? null, o.conflito_em ?? null,
    o.cliente_nome ?? null, o.forma_pagamento ?? 'dinheiro',
    o.subtotal ?? 0, o.desconto ?? 0, o.total ?? 0,
    o.created_at ?? '2026-09-01T00:00:00.000Z', o.synced_at ?? '2026-09-01T00:00:00.000Z');
  return o;
}

function item(sq, id, orcamentoId, nome, total = 10) {
  sq.prepare(`INSERT INTO orcamento_itens (id, orcamento_id, produto_nome, quantidade, preco_unitario, desconto, total)
    VALUES (?,?,?,?,?,?,?)`).run(id, orcamentoId, nome, 1, total, 0, total);
}

function naFila(sq, id, orcamentoId) {
  sq.prepare(`INSERT INTO sync_queue (id, entidade, operacao, payload, created_at, processado)
    VALUES (?,?,?,?,?,0)`).run(id, 'orcamento', 'update',
    JSON.stringify({ orcamento_id: orcamentoId }), '2026-09-10T00:00:00.000Z');
}

/** Um tombstone como `orcamentosCanceladosNoServidor` devolve. */
const tumulo = (id, numero) => ({ id, numero, status: 'cancelado' });

const AGORA = '2026-09-10T18:00:00.000Z';
const cancelar = (sq, lista) => orcSql.aplicarCancelamentosDoCloud(sq, lista, AGORA);
const ler = (sq, id) => sq.prepare('SELECT * FROM orcamentos WHERE id = ?').get(id);
const quantas = (sq) => sq.prepare('SELECT COUNT(*) n FROM orcamentos').get().n;

// ───────────────────────────────────────────────────────────────────────
describe('O DEFEITO — a descida de ativos sozinha não conta nada', () => {
  test('documento cancelado some do lote e a linha local fica velha', () => {
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 7, status: 'pendente' });
    // O servidor cancelou o `a`, então ele NÃO vem no lote de ativos.
    orcSql.reconciliarDoCloud(sq, [
      { id: 'b', remote_id: 'b', numero: 8, status: 'aberto', total: 10, created_at: AGORA },
    ], AGORA);
    assert.equal(ler(sq, 'a').status, 'pendente',
      'sem o fluxo de tombstone, ninguém aqui fica sabendo — é a lacuna desta fase');
  });
});

describe('1-3. o caso central e a idempotência', () => {
  test('local ativo / servidor cancelado → local passa a cancelado', () => {
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 7, status: 'pendente', total: 529.99 });
    const r = cancelar(sq, [tumulo('a', 7)]);

    assert.equal(r.aplicados, 1);
    assert.equal(r.total, 1);
    assert.deepEqual(r.falhas, []);
    assert.equal(r.conflitos.length, 0);
    const l = ler(sq, 'a');
    assert.equal(l.status, 'cancelado');
    assert.equal(l.synced_at, AGORA);
  });

  test('o mesmo cancelamento duas vezes: idempotente', () => {
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 7, status: 'pendente' });
    cancelar(sq, [tumulo('a', 7)]);
    const antes = ler(sq, 'a');
    const r2 = cancelar(sq, [tumulo('a', 7)]);
    assert.equal(r2.aplicados, 0);
    assert.equal(r2.ja_cancelados, 1, 'reconhecido, não reaplicado');
    assert.deepEqual(ler(sq, 'a'), antes, 'nem o synced_at foi mexido de novo');
  });

  test('o mesmo cancelamento depois de reabrir o Electron: idempotente', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-064-'));
    const arquivo = path.join(dir, 'pdv.db');
    try {
      const sq = banco(arquivo);
      local(sq, { id: 'a', remote_id: 'a', numero: 7, status: 'pendente' });
      cancelar(sq, [tumulo('a', 7)]);
      sq.close();

      const sq2 = new DatabaseSync(arquivo);
      const r = orcSql.aplicarCancelamentosDoCloud(sq2, [tumulo('a', 7)], '2026-09-11T00:00:00.000Z');
      assert.equal(r.ja_cancelados, 1);
      assert.equal(r.aplicados, 0);
      assert.equal(sq2.prepare('SELECT status FROM orcamentos WHERE id = ?').get('a').status, 'cancelado');
      sq2.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('4-6. identidade', () => {
  test('id_local ≠ remote_id: encontra pelo remote_id', () => {
    const sq = banco();
    local(sq, { id: 'd87547a7', remote_id: 'ee29e3b9', numero: 59, status: 'pendente' });
    const r = cancelar(sq, [tumulo('ee29e3b9', 59)]);
    assert.equal(r.aplicados, 1);
    const l = ler(sq, 'd87547a7');
    assert.equal(l.status, 'cancelado');
    assert.equal(l.id, 'd87547a7', 'id local intacto');
    assert.equal(l.remote_id, 'ee29e3b9', 'remote_id intacto');
  });

  test('identidade ambígua: NENHUMA linha é alterada', () => {
    const sq = banco();
    local(sq, { id: 'A', remote_id: 'X', numero: 11, status: 'pendente' });
    local(sq, { id: 'X', remote_id: null, numero: 22, status: 'pendente' });
    const antesA = ler(sq, 'A'); const antesX = ler(sq, 'X');

    const r = cancelar(sq, [tumulo('X', 99)]);

    assert.equal(r.ambiguos, 1);
    assert.equal(r.aplicados, 0);
    assert.equal(r.ambiguidades[0].motivo, 'identidade_ambigua');
    assert.deepEqual(r.ambiguidades[0].ids_locais, ['A', 'X']);
    assert.deepEqual(r.ambiguidades[0].remote_ids_locais, ['X', null]);
    assert.deepEqual(ler(sq, 'A'), antesA);
    assert.deepEqual(ler(sq, 'X'), antesX);
    assert.equal(quantas(sq), 2);
  });

  test('cancelamento de documento que não existe aqui NÃO cria documento', () => {
    // O nº7 real: cancelado no servidor, nunca baixado por este terminal.
    const sq = banco();
    local(sq, { id: 'outro', remote_id: 'outro', numero: 60, status: 'pendente' });
    const r = cancelar(sq, [tumulo('87c64fa6', 7)]);
    assert.equal(r.desconhecidos, 1);
    assert.equal(r.aplicados, 0);
    assert.equal(quantas(sq), 1, 'nenhum documento inventado');
    assert.equal(ler(sq, 'outro').status, 'pendente', 'e nada respingou no que existe');
  });
});

describe('7. operação local pendente = CONFLITO, nunca sobrescrita', () => {
  for (const [rotulo, extra] of [
    ['sync_status pendente', { sync_status: 'pending' }],
    ['chave de operação viva', { sync_status: 'synced', op_chave: 'a:r1:salvar' }],
    ['em conflito de versão', { sync_status: 'conflito' }],
  ]) {
    test(`${rotulo}: o cancelamento remoto NÃO é aplicado`, () => {
      const sq = banco();
      local(sq, { id: 'a', remote_id: 'a', numero: 60, status: 'pendente', total: 276.3, ...extra });
      naFila(sq, 'q1', 'a');

      const r = cancelar(sq, [tumulo('a', 60)]);

      assert.equal(r.aplicados, 0);
      assert.equal(r.conflitos.length, 1);
      assert.equal(r.conflitos[0].motivo, 'operacao_local_pendente');
      assert.equal(r.conflitos[0].numero, 60);

      const l = ler(sq, 'a');
      assert.equal(l.status, 'pendente', 'status local NÃO foi sobrescrito');
      assert.equal(l.sync_status, extra.sync_status, 'sync_status intacto');
      assert.equal(l.op_chave, extra.op_chave ?? null, 'a chave de idempotência SOBREVIVE');
      assert.equal(l.total, 276.3);
      assert.equal(l.conflito_em, AGORA, 'e o conflito ficou observável no dado, não só no log');
      assert.equal(sq.prepare('SELECT COUNT(*) n FROM sync_queue WHERE processado = 0').get().n, 1,
        'a fila NÃO foi apagada');
    });
  }

  test('o conflito é marcado uma vez só', () => {
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 60, sync_status: 'pending' });
    cancelar(sq, [tumulo('a', 60)]);
    const depois1 = ler(sq, 'a');
    orcSql.aplicarCancelamentosDoCloud(sq, [tumulo('a', 60)], '2026-09-11T00:00:00.000Z');
    assert.deepEqual(ler(sq, 'a'), depois1, 'conflito_em não fica sendo reescrito a cada ciclo');
  });
});

describe('8. isolamento: um tombstone não derruba o lote', () => {
  test('o problemático falha sozinho e os demais são aplicados', () => {
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 1, status: 'pendente' });
    local(sq, { id: 'b', remote_id: 'b', numero: 2, status: 'pendente' });

    // Um `id` que o SQLite não consegue ligar — o servidor devolvendo algo
    // torto. De propósito NÃO é a ambiguidade nem o desconhecido, que são
    // casos previstos: o isolamento não pode depender de eu ter previsto.
    const ruim = tumulo({ nao: 'ligável' }, 1);

    const r = cancelar(sq, [tumulo('b', 2), ruim, tumulo('b', 2)]);

    assert.equal(r.falhas.length, 1, 'a falha foi contada, não engolida');
    assert.ok(r.falhas[0].erro, 'com a mensagem do banco junto');
    assert.equal(r.aplicados, 1, 'o `b`, que veio ANTES da falha, entrou');
    assert.equal(r.ja_cancelados, 1, 'e o `b` repetido, DEPOIS da falha, foi reconhecido');
    assert.equal(ler(sq, 'b').status, 'cancelado');
    assert.equal(ler(sq, 'a').status, 'pendente', 'o problemático não respingou em ninguém');
    assert.equal(quantas(sq), 2, 'e nada foi criado');
  });

  test('ambiguidade no meio do lote não impede os outros', () => {
    const sq = banco();
    local(sq, { id: 'A', remote_id: 'X', numero: 11, status: 'pendente' });
    local(sq, { id: 'X', remote_id: null, numero: 22, status: 'pendente' });
    local(sq, { id: 'c', remote_id: 'c', numero: 33, status: 'pendente' });

    const r = cancelar(sq, [tumulo('X', 11), tumulo('c', 33)]);

    assert.equal(r.ambiguos, 1);
    assert.equal(r.aplicados, 1);
    assert.equal(ler(sq, 'c').status, 'cancelado');
  });
});

describe('9-14. o que o cancelamento NÃO pode tocar', () => {
  function comTudo() {
    const sq = banco();
    local(sq, {
      id: '1a4ca66e', remote_id: '1a4ca66e', numero: 60, status: 'pendente',
      revisao_base: 3, subtotal: 276.3, total: 276.3, cliente_nome: 'Eliane',
      created_at: '2026-09-09T23:27:47.404Z',
    });
    item(sq, 'i1', '1a4ca66e', 'CIMENTO CP-3 40 VOTORAM 50KG', 272.3);
    item(sq, 'i2', '1a4ca66e', 'GESSO RAPIDO 1KG', 4);
    naFila(sq, 'q1', 'outro-doc');
    return sq;
  }

  test('itens permanecem intactos', () => {
    const sq = comTudo();
    const antes = sq.prepare('SELECT * FROM orcamento_itens ORDER BY id').all();
    cancelar(sq, [tumulo('1a4ca66e', 60)]);
    assert.deepEqual(sq.prepare('SELECT * FROM orcamento_itens ORDER BY id').all(), antes);
  });

  test('numero, total e cliente permanecem intactos', () => {
    const sq = comTudo();
    cancelar(sq, [tumulo('1a4ca66e', 60)]);
    const l = ler(sq, '1a4ca66e');
    assert.equal(l.numero, 60);
    assert.equal(l.total, 276.3);
    assert.equal(l.subtotal, 276.3);
    assert.equal(l.cliente_nome, 'Eliane');
    assert.equal(l.created_at, '2026-09-09T23:27:47.404Z');
  });

  test('revisao_base NÃO avança — a descida não trouxe os itens da revisão', () => {
    const sq = comTudo();
    cancelar(sq, [tumulo('1a4ca66e', 60)]);
    assert.equal(ler(sq, '1a4ca66e').revisao_base, 3);
  });

  test('identidade preservada e nenhum documento novo', () => {
    const sq = comTudo();
    cancelar(sq, [tumulo('1a4ca66e', 60)]);
    const l = ler(sq, '1a4ca66e');
    assert.equal(l.id, '1a4ca66e');
    assert.equal(l.remote_id, '1a4ca66e');
    assert.equal(quantas(sq), 1);
  });

  test('a fila não é apagada nem marcada', () => {
    const sq = comTudo();
    const antes = sq.prepare('SELECT * FROM sync_queue ORDER BY id').all();
    cancelar(sq, [tumulo('1a4ca66e', 60)]);
    assert.deepEqual(sq.prepare('SELECT * FROM sync_queue ORDER BY id').all(), antes);
  });

  test('nada é apagado: o documento continua no histórico', () => {
    const sq = comTudo();
    cancelar(sq, [tumulo('1a4ca66e', 60)]);
    assert.ok(ler(sq, '1a4ca66e'), 'documento continua lá');
    assert.equal(sq.prepare('SELECT COUNT(*) n FROM orcamento_itens').get().n, 2, 'itens continuam lá');
  });
});

describe('15-17. o renderer bloqueia ação de negócio em orçamento cancelado', () => {
  const cancelado = { id: 'a', status: 'cancelado', numero: 60 };
  const convertido = { id: 'a', status: 'convertido', numero: 60 };

  test('não permite editar', () => {
    assert.equal(Acoes.podeEditar(cancelado), false);
    assert.equal(Acoes.botoesDeEdicaoNaLista(cancelado), false);
  });

  test('não permite converter em venda', () => {
    assert.equal(Acoes.podeConverter(cancelado), false);
  });

  test('não permite cancelar de novo', () => {
    // Antes da 0.6C.4 `cancelar()` não tinha guarda nenhuma: só o botão
    // escondido separava um cancelado de ser cancelado outra vez.
    assert.equal(Acoes.podeCancelar(cancelado), false);
    assert.equal(Acoes.podeCancelar(convertido), false);
  });

  test('mas o documento continua visível — cancelar não é apagar', () => {
    assert.equal(Acoes.ehTerminal(cancelado), true);
    assert.ok('status' in cancelado, 'a linha existe e é renderizável');
  });
});

describe('18-20. nada do que já funcionava regrediu', () => {
  test('orçamento aberto continua editável, conversível e cancelável', () => {
    const vivo = { id: 'a', status: 'pendente', numero: 61 };
    assert.equal(Acoes.podeEditar(vivo), true);
    assert.equal(Acoes.podeConverter(vivo), true);
    assert.equal(Acoes.podeCancelar(vivo), true);
    assert.equal(Acoes.botoesDeEdicaoNaLista(vivo), true);
  });

  test('linha só de nuvem continua sem ação de negócio', () => {
    const daNuvem = { id: 'a', status: 'pendente', _origem: 'cloud' };
    assert.equal(Acoes.podeEditar(daNuvem), false);
    assert.equal(Acoes.podeConverter(daNuvem), false);
  });

  test('o nº60 do piloto sobrevive a um lote que não é dele', () => {
    const sq = banco();
    local(sq, {
      id: '1a4ca66e', remote_id: '1a4ca66e', numero: 60, status: 'pendente',
      revisao_base: 3, total: 276.3,
    });
    local(sq, { id: 'outro', remote_id: 'outro', numero: 7, status: 'pendente' });
    const antes = ler(sq, '1a4ca66e');

    cancelar(sq, [tumulo('outro', 7)]);

    assert.deepEqual(ler(sq, '1a4ca66e'), antes, 'nem um campo do nº60 mudou');
  });

  test('REGRESSÃO 0.6C.3: o UNIQUE(remote_id) não volta', () => {
    // Os dois fluxos no mesmo banco, com a identidade histórica que derrubava
    // a descida antes da 0.6C.3.
    const sq = banco();
    local(sq, { id: 'd87547a7', remote_id: 'ee29e3b9', numero: 58, status: 'pendente' });
    local(sq, { id: 'x', remote_id: 'x', numero: 60, status: 'pendente' });

    const a = orcSql.reconciliarDoCloud(sq, [
      { id: 'ee29e3b9', remote_id: 'ee29e3b9', numero: 59, status: 'aberto', total: 389, created_at: AGORA },
      { id: 'x', remote_id: 'x', numero: 60, status: 'aberto', total: 276.3, created_at: AGORA },
    ], AGORA);
    const b = cancelar(sq, [tumulo('x', 60)]);

    assert.deepEqual(a.falhas, [], 'descida de ativos sem UNIQUE');
    assert.deepEqual(b.falhas, [], 'descida de cancelamento sem UNIQUE');
    assert.equal(a.inseridos, 0, 'nenhum documento duplicado');
    assert.equal(quantas(sq), 2);
    assert.equal(ler(sq, 'd87547a7').numero, 59, 'e a reconciliação de número segue valendo');
    assert.equal(ler(sq, 'x').status, 'cancelado');
  });

  test('o tombstone nunca insere — em nenhum caminho', () => {
    const sq = banco();
    const r = cancelar(sq, [tumulo('nao-existe', 1), tumulo('nem-esse', 2)]);
    assert.equal(r.desconhecidos, 2);
    assert.equal(quantas(sq), 0);
  });
});

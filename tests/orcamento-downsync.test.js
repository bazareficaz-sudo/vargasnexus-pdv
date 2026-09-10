const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const orcSql = require('../src/main/orcamentoSql');

// FASE 0.6C.3 — A DESCIDA DE ORÇAMENTOS.
//
// O defeito, medido em produção: `UNIQUE constraint failed: orcamentos.remote_id`
// a cada ciclo de sync, de 2 em 2 minutos, desde 08/09/2026 — 988 ocorrências
// até 10/09.
//
// A tabela local tem DUAS colunas de identidade, `id` (PK) e `remote_id`
// (UNIQUE). O lote que desce traz o id do SERVIDOR. Num orçamento nascido no
// legado, esse id mora no `remote_id` de uma linha cujo `id` é outro:
//
//     local   id = d87547a7…   remote_id = ee29e3b9…   nº58
//     cloud   id = ee29e3b9…                           nº59
//
// `ON CONFLICT(id)` procurava a PK `ee29e3b9…`, não achava, virava INSERT, e
// o INSERT batia no `remote_id` que `d87547a7…` já ocupava. A falha caía no
// item 2 de 56 e o rollback da transação levava os outros 54 junto.
//
// Estes testes rodam a MESMA FUNÇÃO que o app executa — `reconciliarDoCloud`
// só precisa de `prepare()` e `exec()`, que better-sqlite3 e node:sqlite têm
// igual. Não há imitação do comportamento em lugar nenhum.

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
`;

/** Um SQLite real, vazio. As linhas locais entram uma a uma, explícitas. */
function banco() {
  const sq = new DatabaseSync(':memory:');
  sq.exec(DDL);
  return sq;
}

function local(sq, o) {
  sq.prepare(`INSERT INTO orcamentos
    (id, remote_id, numero, status, sync_status, revisao_base, cliente_nome,
     cliente_telefone, forma_pagamento, subtotal, desconto, total, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    o.id, o.remote_id ?? null, o.numero ?? null, o.status ?? 'pendente',
    o.sync_status ?? 'synced', o.revisao_base ?? 0, o.cliente_nome ?? null,
    o.cliente_telefone ?? null, o.forma_pagamento ?? 'dinheiro',
    o.subtotal ?? 0, o.desconto ?? 0, o.total ?? 0,
    o.created_at ?? '2026-09-01T00:00:00.000Z');
  return o;
}

function item(sq, id, orcamentoId, nome) {
  sq.prepare(`INSERT INTO orcamento_itens (id, orcamento_id, produto_nome, quantidade, preco_unitario, desconto, total)
    VALUES (?,?,?,?,?,?,?)`).run(id, orcamentoId, nome, 1, 10, 0, 10);
}

/**
 * Uma linha como `_mapOrcamentoRemoto` a entrega: `id` e `remote_id` são
 * ambos o id do servidor, `status` é sempre 'aberto' (a consulta filtra
 * assim) e `cliente_telefone` é sempre null.
 */
const doCloud = (o) => ({
  id: o.id, remote_id: o.id, numero: o.numero, status: 'aberto',
  cliente_id: null, cliente_nome: o.cliente_nome ?? null, cliente_telefone: null,
  vendedor_nome: null, forma_pagamento: null, validade_dias: null,
  subtotal: o.total ?? 0, desconto: 0, total: o.total ?? 0,
  observacao: null, created_at: o.created_at ?? '2026-09-01T00:00:00.000Z',
});

const baixar = (sq, lista) => orcSql.reconciliarDoCloud(sq, lista, '2026-09-10T14:00:00.000Z');
const ler = (sq, id) => sq.prepare('SELECT * FROM orcamentos WHERE id = ?').get(id);
const todas = (sq) => sq.prepare('SELECT * FROM orcamentos ORDER BY numero').all();
const quantas = (sq) => sq.prepare('SELECT COUNT(*) n FROM orcamentos').get().n;

// ───────────────────────────────────────────────────────────────────────
describe('1-3. o caso real: id_local ≠ remote_id', () => {
  test('o nº58 do Escritório Silvano desce sem estourar UNIQUE', () => {
    // ESTE TESTE FALHA NO CÓDIGO ANTERIOR À 0.6C.3.
    // Ids e números reais, medidos em 10/09/2026.
    const sq = banco();
    local(sq, { id: 'd87547a7', remote_id: 'ee29e3b9', numero: 58, total: 389 });
    item(sq, 'i1', 'd87547a7', 'CIMENTO CP-3 40 VOTORAM 50KG');

    const r = baixar(sq, [doCloud({ id: 'ee29e3b9', numero: 59, total: 389 })]);

    assert.deepEqual(r.falhas, [], 'nenhuma falha');
    assert.equal(r.atualizados, 1, 'encontrou a linha pelo remote_id');
    assert.equal(r.inseridos, 0, 'e NÃO criou um segundo documento');
    assert.equal(quantas(sq), 1);

    const l = ler(sq, 'd87547a7');
    assert.equal(l.id, 'd87547a7', 'id local preservado');
    assert.equal(l.remote_id, 'ee29e3b9', 'remote_id preservado');
    assert.equal(l.numero, 59, 'número comercial oficial adotado');
    assert.equal(sq.prepare('SELECT COUNT(*) n FROM orcamento_itens WHERE orcamento_id = ?').get('d87547a7').n,
      1, 'itens preservados e ainda apontando para o id local');
  });

  test('a linha é localizada por remote_id OU por id', () => {
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'ra', numero: 1 });   // nascido no legado
    local(sq, { id: 'b', remote_id: 'b', numero: 2 });    // identidades já convergidas

    baixar(sq, [doCloud({ id: 'ra', numero: 11 }), doCloud({ id: 'b', numero: 22 })]);

    assert.equal(quantas(sq), 2, 'nenhuma linha nova');
    assert.equal(ler(sq, 'a').numero, 11);
    assert.equal(ler(sq, 'b').numero, 22);
  });

  test('GUARDRAIL: duas linhas locais para o mesmo cloud.id → nada é escrito', () => {
    // local A: id=A, remote_id=X
    // local B: id=X
    // cloud:   id=X
    //
    // As duas dizem ser o documento X. Escolher uma — como o `LIMIT 1` fazia —
    // seria transformar uma corrupção histórica numa decisão automática
    // invisível. A camada de descida não tem informação para decidir isso, e
    // por isso não decide.
    const sq = banco();
    local(sq, { id: 'A', remote_id: 'X', numero: 11, total: 100 });
    local(sq, { id: 'X', remote_id: null, numero: 22, total: 200 });
    local(sq, { id: 'c', remote_id: 'c', numero: 33, total: 300 });
    item(sq, 'iA', 'A', 'CIMENTO');
    item(sq, 'iX', 'X', 'GESSO');

    const antesA = ler(sq, 'A');
    const antesX = ler(sq, 'X');

    const r = baixar(sq, [
      doCloud({ id: 'X', numero: 99, total: 999 }),   // o ambíguo
      doCloud({ id: 'c', numero: 44, total: 400 }),   // o resto do lote
    ]);

    // 1. o item saiu como conflito, e o caso foi registrado por inteiro
    assert.equal(r.ambiguos, 1);
    assert.equal(r.atualizados, 1, 'só o item são do lote foi aplicado');
    assert.equal(r.inseridos, 0);
    assert.deepEqual(r.falhas, [], 'ambiguidade não é falha de banco — é decisão recusada');

    const a = r.ambiguidades[0];
    assert.equal(a.motivo, 'identidade_ambigua');
    assert.equal(a.cloud_id, 'X');
    assert.equal(a.numero_cloud, 99);
    assert.deepEqual(a.ids_locais, ['A', 'X']);
    assert.deepEqual(a.remote_ids_locais, ['X', null]);
    assert.deepEqual(a.numeros_locais, [11, 22]);

    // 2. nenhuma linha apagada, nenhuma terceira criada
    assert.equal(quantas(sq), 3);
    assert.ok(ler(sq, 'A'));
    assert.ok(ler(sq, 'X'));

    // 3. nenhuma sobrescrita — nem um campo
    assert.deepEqual(ler(sq, 'A'), antesA);
    assert.deepEqual(ler(sq, 'X'), antesX);
    assert.equal(sq.prepare('SELECT COUNT(*) n FROM orcamento_itens').get().n, 2, 'itens intactos');

    // 4. o resto do lote seguiu
    assert.equal(ler(sq, 'c').numero, 44);
    assert.equal(ler(sq, 'c').total, 400);

    // 5. rerun determinístico
    const r2 = baixar(sq, [
      doCloud({ id: 'X', numero: 99, total: 999 }),
      doCloud({ id: 'c', numero: 44, total: 400 }),
    ]);
    assert.equal(r2.ambiguos, 1);
    assert.equal(r2.inseridos, 0);
    assert.deepEqual(r2.ambiguidades[0], a, 'mesmo relato, sem deriva');
    assert.deepEqual(ler(sq, 'A'), antesA);
    assert.deepEqual(ler(sq, 'X'), antesX);
    assert.equal(quantas(sq), 3);
  });

  test('uma correspondência só continua resolvendo normalmente', () => {
    // O guardrail não pode ter tornado o caso normal mais frouxo.
    const sq = banco();
    local(sq, { id: 'A', remote_id: 'X', numero: 11 });
    const r = baixar(sq, [doCloud({ id: 'X', numero: 99 })]);
    assert.equal(r.ambiguos, 0);
    assert.equal(r.atualizados, 1);
    assert.equal(ler(sq, 'A').numero, 99);
  });
});

describe('4-6. o que a descida escreve — e o que ela não pode escrever', () => {
  test('número oficial é adotado', () => {
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 59 });
    baixar(sq, [doCloud({ id: 'a', numero: 60 })]);
    assert.equal(ler(sq, 'a').numero, 60);
  });

  test('número ausente no cloud não apaga o número local', () => {
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 60 });
    baixar(sq, [doCloud({ id: 'a', numero: null })]);
    assert.equal(ler(sq, 'a').numero, 60);
  });

  test('STATUS: o local é preservado — a descida não consegue expressar status', () => {
    // A consulta do down-sync filtra `status IN ('aberto')`. Toda linha que
    // desce tem status 'aberto', sempre. Escrever essa coluna não transmite
    // informação nenhuma; só transforma o 'pendente' local — que é o que dá
    // botão de editar, converter e cancelar na tela — num 'aberto' que não dá.
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 60, status: 'pendente' });

    baixar(sq, [doCloud({ id: 'a', numero: 60 })]);

    const l = ler(sq, 'a');
    assert.equal(l.status, 'pendente', 'continua no vocabulário local');
    // A regra exata que a tela usa para oferecer editar / converter em venda:
    assert.ok(l.status === 'pendente' || l.status === 'aprovado',
      'o orçamento continua editável e conversível depois da descida');
  });

  test('TELEFONE: a descida manda null fixo, então não escreve', () => {
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 1, cliente_telefone: '11999998888' });
    baixar(sq, [doCloud({ id: 'a', numero: 1 })]);
    assert.equal(ler(sq, 'a').cliente_telefone, '11999998888', 'não foi apagado');
  });

  test('REVISÃO: preservada de propósito — a descida traz só o cabeçalho', () => {
    // Adotar a revisão do servidor sem os itens deixaria este terminal
    // declarar `revisao_base` de um estado que ele não tem, e sobrescrever os
    // itens de outro terminal na próxima edição. Com a revisão velha, a
    // próxima edição leva 409 e PARA — que é o desfecho correto.
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 60, revisao_base: 3 });
    baixar(sq, [doCloud({ id: 'a', numero: 60 })]);
    assert.equal(ler(sq, 'a').revisao_base, 3);
  });

  test('cliente e total, esses sim, vêm do servidor', () => {
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 1, cliente_nome: 'antigo', total: 10 });
    baixar(sq, [doCloud({ id: 'a', numero: 1, cliente_nome: 'Eliane', total: 276.3 })]);
    const l = ler(sq, 'a');
    assert.equal(l.cliente_nome, 'Eliane', 'outro terminal pode ter editado');
    assert.equal(l.total, 276.3);
  });

  test('edição local ainda não enviada não é atropelada, e isso é contado', () => {
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 59, total: 10, sync_status: 'pending' });
    const r = baixar(sq, [doCloud({ id: 'a', numero: 60, total: 999 })]);
    const l = ler(sq, 'a');
    assert.equal(l.numero, 59);
    assert.equal(l.total, 10);
    assert.equal(r.preservados, 1);
    assert.equal(r.atualizados, 0);
  });
});

describe('7-8. o lote: um problema não derruba os outros', () => {
  test('vários orçamentos no mesmo lote, misturando novos e existentes', () => {
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 1 });
    local(sq, { id: 'b', remote_id: 'rb', numero: 2 });    // nascido no legado

    const r = baixar(sq, [
      doCloud({ id: 'a', numero: 11 }),
      doCloud({ id: 'rb', numero: 22 }),
      doCloud({ id: 'novo-1', numero: 33 }),
      doCloud({ id: 'novo-2', numero: 44 }),
    ]);

    assert.deepEqual(r.falhas, []);
    assert.equal(r.atualizados, 2);
    assert.equal(r.inseridos, 2);
    assert.equal(quantas(sq), 4);
    assert.deepEqual(todas(sq).map(o => o.numero), [11, 22, 33, 44]);
  });

  test('uma linha impossível falha sozinha; as outras entram', () => {
    // ESTE TESTE FALHA NO CÓDIGO ANTERIOR À 0.6C.3: lá, uma linha ruim
    // abortava a transação e nenhuma das outras era aplicada.
    //
    // A linha ruim aqui NÃO é a colisão de identidade que acabei de corrigir:
    // é um `total` que não dá para ligar ao SQLite, como o servidor devolvendo
    // um objeto onde deveria vir número. De propósito — o isolamento não pode
    // depender de eu ter previsto o defeito.
    const sq = banco();
    local(sq, { id: 'a', remote_id: 'a', numero: 1 });

    const ruim = doCloud({ id: 'novo-ruim', numero: 77 });
    ruim.total = { valor: 10 };

    const r = baixar(sq, [
      doCloud({ id: 'a', numero: 11 }),
      ruim,
      doCloud({ id: 'novo-ok', numero: 88 }),
    ]);

    assert.equal(r.falhas.length, 1, 'a falha foi contada, não engolida');
    assert.equal(r.falhas[0].numero, 77);
    assert.ok(r.falhas[0].erro, 'com a mensagem do banco junto');
    assert.equal(r.atualizados, 1);
    assert.equal(r.inseridos, 1);
    assert.equal(ler(sq, 'a').numero, 11, 'quem veio ANTES da falha ficou');
    assert.ok(ler(sq, 'novo-ok'), 'quem veio DEPOIS da falha entrou');
    assert.equal(quantas(sq), 2, 'a atualizada e a inserida — a linha ruim não ficou nem pela metade');
    assert.equal(ler(sq, 'novo-ruim'), undefined, 'e não entrou de jeito nenhum');
  });

  test('o SAVEPOINT desfaz só a linha que falhou', () => {
    const sq = banco();
    const r = baixar(sq, [(() => { const o = doCloud({ id: 'x', numero: 1 }); o.total = { v: 1 }; return o; })()]);
    assert.equal(r.falhas.length, 1);
    assert.equal(quantas(sq), 0, 'nada meio-gravado');
  });
});

describe('9-10. reexecução e ausência de duplicidade', () => {
  test('rodar o mesmo lote três vezes não muda o resultado', () => {
    const sq = banco();
    local(sq, { id: 'd87547a7', remote_id: 'ee29e3b9', numero: 58, total: 389 });
    const lote = [
      doCloud({ id: 'ee29e3b9', numero: 59, total: 389 }),
      doCloud({ id: 'novo', numero: 60, total: 276.3 }),
    ];

    const r1 = baixar(sq, lote);
    const depois1 = todas(sq);
    baixar(sq, lote);
    const r3 = baixar(sq, lote);

    assert.equal(quantas(sq), 2, 'continua com dois documentos');
    assert.deepEqual(todas(sq).map(o => [o.id, o.remote_id, o.numero]),
      depois1.map(o => [o.id, o.remote_id, o.numero]), 'estado idêntico');
    assert.equal(r1.inseridos, 1, 'primeira passada insere o novo');
    assert.equal(r3.inseridos, 0, 'as seguintes só atualizam');
    assert.deepEqual(r3.falhas, []);
  });

  test('nenhum documento é duplicado: identidades distintas = linhas', () => {
    const sq = banco();
    local(sq, { id: 'd87547a7', remote_id: 'ee29e3b9', numero: 58 });
    local(sq, { id: '1a4ca66e', remote_id: '1a4ca66e', numero: 60 });
    local(sq, { id: 'a4d09df2', remote_id: 'a4d09df2', numero: 57 });

    baixar(sq, [
      doCloud({ id: 'ee29e3b9', numero: 59 }),
      doCloud({ id: '1a4ca66e', numero: 60 }),
      doCloud({ id: 'a4d09df2', numero: 57 }),
    ]);

    const linhas = todas(sq);
    const identidades = new Set(linhas.map(o => o.remote_id || o.id));
    assert.equal(linhas.length, 3);
    assert.equal(identidades.size, 3, '1:1 entre identidade e linha');
    assert.equal(new Set(linhas.map(o => o.numero)).size, 3, 'e nenhum número repetido');
  });

  test('um documento novo de outro terminal entra uma vez só', () => {
    const sq = banco();
    baixar(sq, [doCloud({ id: 'de-outro', numero: 7 })]);
    baixar(sq, [doCloud({ id: 'de-outro', numero: 7 })]);
    assert.equal(quantas(sq), 1);
    const l = ler(sq, 'de-outro');
    assert.equal(l.remote_id, 'de-outro');
    assert.equal(l.status, 'aberto', 'linha que nasce do cloud não é editável aqui — não tem itens');
    assert.equal(l.sync_status, 'synced');
  });
});

describe('PROVA POR CONTRADIÇÃO — o lote real de 10/09/2026', () => {
  test('56 linhas do servidor, a colisão no item 2, e nada se perde', () => {
    // Reprodução do lote medido: 56 orçamentos, o segundo sendo o ee29e3b9
    // que colide. No código anterior, o erro caía no item 2 e os 54 seguintes
    // nunca eram aplicados — `synced_at` não mudava em nenhuma linha.
    const sq = banco();
    local(sq, { id: 'd87547a7', remote_id: 'ee29e3b9', numero: 58, total: 389 });
    local(sq, { id: '1a4ca66e', remote_id: '1a4ca66e', numero: 60, total: 276.3 });

    const lote = [doCloud({ id: '1a4ca66e', numero: 60, total: 276.3 })];
    lote.push(doCloud({ id: 'ee29e3b9', numero: 59, total: 389 }));     // o item 2
    for (let i = 3; i <= 56; i++) lote.push(doCloud({ id: `outro-${i}`, numero: i }));

    const r = baixar(sq, lote);

    assert.equal(r.total, 56);
    assert.deepEqual(r.falhas, [], 'zero UNIQUE');
    assert.equal(r.atualizados, 2);
    assert.equal(r.inseridos, 54, 'os 54 que o rollback comia');
    assert.equal(quantas(sq), 56);

    const aplicadas = sq.prepare("SELECT COUNT(*) n FROM orcamentos WHERE synced_at = '2026-09-10T14:00:00.000Z'").get().n;
    assert.equal(aplicadas, 56, 'todas aplicadas — antes eram 0');
    assert.equal(ler(sq, 'd87547a7').numero, 59, 'e o histórico reconciliado');
    assert.equal(ler(sq, '1a4ca66e').numero, 60, 'sem tocar no que já estava certo');
  });
});

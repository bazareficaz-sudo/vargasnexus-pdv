const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { abrir, ambiente, syncFalso, PRODUTO, ROTA_DESLIGADA, SEM_IDENTIDADE } = require('./helpers/venda-sync');
const { recusaPreWrite, escolherProtocolo } = require('../src/main/protocoloVenda');

const linha = (db, id) => db.vendas.getById(id);
const tipos = chamadas => chamadas.map(c => c[0]);

for (const [nome, resposta] of Object.entries({ rota_desligada: ROTA_DESLIGADA, sem_identidade: SEM_IDENTIDADE })) {
  test(`${nome}: primeira recusa pre-write persiste legado ANTES do efeito`, async t => {
    const { db, id } = ambiente(t);
    const { sync, chamadas } = syncFalso(db, { v1: async () => {
      assert.equal(linha(db, id).sync_protocolo, 'negociando_v1');
      return resposta;
    }, legado: async v => {
      assert.equal(linha(db, id).sync_protocolo, 'legado');
      return { id: v.id };
    } });
    await sync.retentarVendaManual(id);
    assert.deepEqual(tipos(chamadas), ['v1', 'legado']);
    assert.equal(linha(db, id).sync_status, 'synced');
    assert.equal(linha(db, id).remote_id, id);
  });
}

for (const resposta of [undefined, {}, { ok: false, motivo: 'rede' },
  { ok: false, motivo: 'timeout' }, { ...ROTA_DESLIGADA, status: 500 },
  { ok: false, motivo: 'sem_identidade', status: 401 },
  { ok: false, motivo: 'rota_desligada' },
  { ok: false, status: 500, corpo: { estado: 'aplicada' } },
  { ok: true, dados: { estado: 'novo_estado' } }]) {
  test(`resposta ambígua não libera legado: ${JSON.stringify(resposta)}`, async t => {
    const { db, id } = ambiente(t);
    const a = syncFalso(db, { v1: async () => resposta });
    await assert.rejects(a.sync.retentarVendaManual(id), /pendente/);
    assert.equal(linha(db, id).sync_protocolo, 'v1');
    assert.equal(linha(db, id).remote_id, null);
    assert.deepEqual(tipos(a.chamadas), ['v1']);
    // Nova instância de sync e flag agora desligada: jamais legado.
    const b = syncFalso(db, { v1: async () => ROTA_DESLIGADA });
    await assert.rejects(b.sync.retentarVendaManual(id), /pendente/);
    assert.deepEqual(tipos(b.chamadas), ['v1']);
  });
}

test('exceção no transporte preserva negociando_v1, gate e retry exclusivo V1', async t => {
  const { db, id } = ambiente(t);
  const a = syncFalso(db, { v1: async () => { throw new Error('resposta perdida'); } });
  await assert.rejects(a.sync.retentarVendaManual(id), /resposta perdida/);
  assert.equal(linha(db, id).sync_protocolo, 'negociando_v1');
  const b = syncFalso(db, { v1: async () => SEM_IDENTIDADE });
  await assert.rejects(b.sync.retentarVendaManual(id), /pendente/);
  assert.equal(linha(db, id).sync_protocolo, 'v1');
  assert.deepEqual(tipos(b.chamadas), ['v1']);
});

test('legado permanece legado mesmo com V1 disponível posteriormente', async t => {
  const { db, id } = ambiente(t);
  const a = syncFalso(db, { v1: async () => ROTA_DESLIGADA,
    legado: async () => { throw new Error('falha legado'); } });
  await assert.rejects(a.sync.retentarVendaManual(id), /falha legado/);
  const b = syncFalso(db);
  await b.sync.retentarVendaManual(id);
  assert.deepEqual(tipos(b.chamadas), ['legado']);
});

for (const protocolo of ['v1', 'negociando_v1', 'estado_desconhecido']) {
  test(`${protocolo}: edição e cancelamento não mudam payload, estoque ou fila`, t => {
    const { db, id } = ambiente(t);
    db.db().prepare('UPDATE vendas SET sync_protocolo=? WHERE id=?').run(protocolo, id);
    const antes = JSON.stringify(linha(db, id));
    const fila = JSON.stringify(db.db().prepare('SELECT * FROM sync_queue').all());
    assert.throws(() => db.vendas.editar(id, [], { total: 0 }), { codigo: 'v1_em_voo' });
    assert.throws(() => db.vendas.cancelar(id, 'teste'), { codigo: 'v1_em_voo' });
    assert.equal(JSON.stringify(linha(db, id)), antes);
    assert.equal(JSON.stringify(db.db().prepare('SELECT * FROM sync_queue').all()), fila);
    assert.equal(db.db().prepare('SELECT quantidade FROM estoque').get().quantidade, 99);
  });
}

test('estado desconhecido não negocia nem envia', async t => {
  const { db, id } = ambiente(t);
  db.db().prepare("UPDATE vendas SET sync_protocolo='futuro' WHERE id=?").run(id);
  const a = syncFalso(db);
  await assert.rejects(a.sync.retentarVendaManual(id), /desconhecido/);
  assert.equal(a.chamadas.length, 0);
});

test('retry manual e fila sobrepostos: uma tentativa e nenhum dual-write', async t => {
  const { db, id } = ambiente(t);
  let liberar, entrou;
  const inicio = new Promise(r => { entrou = r; });
  const espera = new Promise(r => { liberar = r; });
  const a = syncFalso(db, { v1: async () => {
    entrou(); await espera; return ROTA_DESLIGADA;
  } });
  const manual = a.sync.retentarVendaManual(id);
  await inicio;
  const fila = a.sync._processarFilaSync();
  const manual2 = a.sync.retentarVendaManual(id);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(tipos(a.chamadas), ['v1']);
  liberar();
  await Promise.all([manual, fila, manual2]);
  assert.deepEqual(tipos(a.chamadas), ['v1', 'legado']);
});

test('recuperação sem fila usa V1 persistido e não desvia para registrarVenda', async t => {
  const { db, id } = ambiente(t);
  const inicial = syncFalso(db, { v1: async () => { throw new Error('interrompido'); } });
  await assert.rejects(inicial.sync.retentarVendaManual(id), /interrompido/);
  db.db().prepare('DELETE FROM sync_queue').run();
  const a = syncFalso(db, { v1: async () => ROTA_DESLIGADA });
  await a.sync._recuperarVendasPendentes();
  assert.deepEqual(tipos(a.chamadas), ['v1']);
  assert.equal(linha(db, id).remote_id, null);
});

test('arbitragem recusada precede negociação: nenhum efeito de venda', async t => {
  const { db, id } = ambiente(t);
  db.db().prepare("INSERT INTO orcamentos (id,remote_id,numero,status,created_at) VALUES ('orc',?,1,'pendente','2026-09-21')").run(PRODUTO);
  db.db().prepare("UPDATE vendas SET orcamento_id='orc' WHERE id=?").run(id);
  const a = syncFalso(db, { arbitrar: async () => ({ tipo: 'erro', motivo: 'rede' }) });
  await assert.rejects(a.sync.retentarVendaManual(id));
  assert.deepEqual(tipos(a.chamadas), ['arbitragem']);
  assert.equal(linha(db, id).sync_protocolo, null);
});

for (const ponto of ['antes_binding', 'depois_binding', 'envio', 'commit_remoto', 'depois_v1', 'depois_synced', 'antes_legado', 'depois_legado']) {
  test(`crash real de subprocesso e reabertura SQLite: ${ponto}`, async t => {
    const { db, dir, id } = ambiente(t);
    const filho = spawnSync(process.execPath, [path.join(__dirname, 'helpers/crash-venda.js'), dir, id, ponto],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
    assert.equal(filho.status, 77, filho.stderr || filho.stdout);
    const persistido = linha(db, id).sync_protocolo;
    const deveNegociar = ponto === 'antes_binding';
    const legado = ponto === 'depois_legado';
    assert.equal(persistido, deveNegociar ? null : legado ? 'legado' :
      ['depois_v1', 'depois_synced'].includes(ponto) ? 'v1' : 'negociando_v1');
    assert.equal(linha(db, id).sync_payload_v1 == null, deveNegociar,
      'binding e snapshot sobrevivem juntos ao crash');
    const a = syncFalso(db, { v1: async () => ROTA_DESLIGADA });
    if (deveNegociar || legado || ponto === 'depois_synced') await a.sync.retentarVendaManual(id);
    else await assert.rejects(a.sync.retentarVendaManual(id), /pendente/);
    assert.deepEqual(tipos(a.chamadas), deveNegociar ? ['v1', 'legado'] : legado ? ['legado'] :
      ponto === 'depois_synced' ? [] : ['v1']);
    if (ponto === 'commit_remoto') {
      const recibo = JSON.parse(fs.readFileSync(path.join(dir, 'servidor-falso.json'), 'utf8'));
      const b = syncFalso(db, { v1: async corpo => {
        assert.deepEqual(corpo, recibo);
        return { ok: true, dados: { estado: 'ja_aplicada' } };
      } });
      await b.sync.retentarVendaManual(id);
      assert.deepEqual(tipos(b.chamadas), ['v1']);
      assert.equal(linha(db, id).remote_id, id);
    }
  });
}

test('prova de recusa exige origem local ou envelope HTTP 409, nunca só texto', () => {
  assert.equal(recusaPreWrite(SEM_IDENTIDADE), true);
  assert.equal(recusaPreWrite(ROTA_DESLIGADA), true);
  assert.equal(recusaPreWrite({ ok: false, motivo: 'sem_identidade' }), false);
  assert.equal(recusaPreWrite({ ...ROTA_DESLIGADA, status: 503 }), false);
  assert.equal(escolherProtocolo({ sync_protocolo: 'negociando_v1' }), 'v1');
});

test('falha ao persistir binding impede todo envio e preserva venda local', async t => {
  const { db, id } = ambiente(t);
  db.db().exec(`CREATE TRIGGER falhar_binding BEFORE UPDATE OF sync_protocolo ON vendas
    BEGIN SELECT RAISE(ABORT, 'disco indisponivel'); END`);
  const a = syncFalso(db);
  await assert.rejects(a.sync.retentarVendaManual(id), /disco indisponivel/);
  assert.equal(a.chamadas.length, 0);
  assert.equal(linha(db, id).sync_protocolo, null);
  assert.equal(linha(db, id).itens.length, 1);
});

test('falha ao gravar legado depois da recusa não executa legado', async t => {
  const { db, id } = ambiente(t);
  db.db().exec(`CREATE TRIGGER falhar_fallback BEFORE UPDATE OF sync_protocolo ON vendas
    WHEN NEW.sync_protocolo='legado' BEGIN SELECT RAISE(ABORT, 'falha persistencia'); END`);
  const a = syncFalso(db, { v1: async () => ROTA_DESLIGADA });
  await assert.rejects(a.sync.retentarVendaManual(id), /falha persistencia/);
  assert.deepEqual(tipos(a.chamadas), ['v1']);
  assert.equal(linha(db, id).sync_protocolo, 'negociando_v1');
});

test('o gate atua durante request suspenso, inclusive antes de qualquer resposta', async t => {
  const { db, id } = ambiente(t);
  const antes = linha(db, id).itens[0].id;
  const a = syncFalso(db, { v1: async () => {
    await new Promise(r => setImmediate(r));
    assert.throws(() => db.vendas.editar(id, [], {}), { codigo: 'v1_em_voo' });
    assert.throws(() => db.vendas.cancelar(id, 'teste'), { codigo: 'v1_em_voo' });
    return { ok: true, dados: { estado: 'aplicada' } };
  } });
  await a.sync.retentarVendaManual(id);
  assert.equal(linha(db, id).itens[0].id, antes);
  assert.equal(linha(db, id).remote_id, id);
  assert.deepEqual(tipos(a.chamadas), ['v1']);
});

test('conflito tipado no envelope de erro fica terminal sem efeito legado', async t => {
  const { db, id } = ambiente(t);
  const a = syncFalso(db, { v1: async () => ({ ok: false, status: 400,
    corpo: { ok: false, estado: 'payload_invalido', motivo: 'teste' } }) });
  await a.sync.retentarVendaManual(id);
  assert.equal(linha(db, id).sync_protocolo, 'v1');
  assert.equal(linha(db, id).remote_id, null);
  assert.equal(linha(db, id).sync_status, 'conflito_orcamento');
  assert.deepEqual(tipos(a.chamadas), ['v1']);
});

test('arbitragem confirma o UUID antes do request V1 de orçamento', async t => {
  const { db, id } = ambiente(t);
  db.db().prepare("INSERT INTO orcamentos (id,remote_id,numero,status,created_at) VALUES ('orc',?,1,'pendente','2026-09-21')").run(PRODUTO);
  db.db().prepare("UPDATE vendas SET orcamento_id='orc' WHERE id=?").run(id);
  const a = syncFalso(db);
  await a.sync.retentarVendaManual(id);
  assert.deepEqual(tipos(a.chamadas), ['arbitragem', 'v1']);
  assert.equal(a.chamadas[0][1].venda_id, id);
  assert.equal(a.chamadas[1][1].payload.orcamento_id, PRODUTO);
});

test('segunda execução que promove binding impede fallback da primeira execução', async t => {
  const { db, id } = ambiente(t);
  let liberar, entrou;
  const inicio = new Promise(r => { entrou = r; });
  const espera = new Promise(r => { liberar = r; });
  const a = syncFalso(db, { v1: async () => { entrou(); await espera; return ROTA_DESLIGADA; } });
  const primeira = a.sync.retentarVendaManual(id);
  const rejeicao = assert.rejects(primeira, /já encerrada/);
  await inicio;
  // Instância independente: testa o CAS persistido, além do single-flight.
  const b = syncFalso(db, { v1: async () => ({ ok: false, motivo: 'rede' }) });
  await assert.rejects(b.sync.retentarVendaManual(id), /pendente/);
  liberar();
  await rejeicao;
  assert.deepEqual(tipos(a.chamadas), ['v1']);
  assert.deepEqual(tipos(b.chamadas), ['v1']);
  assert.equal(linha(db, id).sync_protocolo, 'v1');
});

test('snapshot sobrevive à reabertura e ignora mudanças de produto, cliente e operador', async t => {
  const { db, id, dir } = ambiente(t);
  db.db().prepare("INSERT INTO clientes (id,remote_id,nome,nome_lower) VALUES ('cliente',?,'Antes','antes')").run(PRODUTO);
  db.db().prepare("UPDATE vendas SET cliente_id='cliente' WHERE id=?").run(id);
  const a = syncFalso(db, { v1: async corpo => {
    assert.deepEqual(JSON.parse(linha(db, id).sync_payload_v1), corpo.payload);
    return { ok: false, motivo: 'rede' };
  } });
  await assert.rejects(a.sync.retentarVendaManual(id), /pendente/);
  const original = linha(db, id).sync_payload_v1;
  db.db().prepare('UPDATE produtos SET remote_id=?').run('55555555-5555-4555-8555-555555555555');
  db.db().prepare("UPDATE clientes SET remote_id=NULL,nome='Depois'").run();
  const reaberto = abrir(dir);
  t.after(() => reaberto.db().close());
  const b = syncFalso(reaberto, { config: { 'auth.usuario': {
    empresa_id: '66666666-6666-4666-8666-666666666666', nome: 'Outro operador',
    deposito_id: '77777777-7777-4777-8777-777777777777',
  } }, v1: async corpo => {
    assert.equal(JSON.stringify(corpo.payload), original);
    return { ok: true, dados: { estado: 'ja_aplicada' } };
  } });
  await b.sync.retentarVendaManual(id);
  assert.equal(linha(reaberto, id).sync_payload_v1, original);
  assert.equal(linha(reaberto, id).remote_id, id);
  assert.deepEqual(tipos(b.chamadas), ['v1']);
});

for (const protocolo of ['v1', 'negociando_v1']) {
  for (const snapshot of [null, '{truncado', '{}', 'null']) {
    test(`${protocolo} com snapshot ${snapshot}: bloqueia antes de qualquer rede`, async t => {
      const { db, id } = ambiente(t);
      db.db().prepare('UPDATE vendas SET sync_protocolo=?,sync_payload_v1=? WHERE id=?').run(protocolo, snapshot, id);
      const a = syncFalso(db);
      await assert.rejects(a.sync.retentarVendaManual(id), { codigo: 'snapshot_v1_invalido' });
      assert.deepEqual(a.chamadas, []);
      assert.equal(linha(db, id).sync_protocolo, protocolo);
      assert.equal(linha(db, id).sync_payload_v1, snapshot);
      assert.throws(() => db.vendas.editar(id, [], {}), { codigo: 'v1_em_voo' });
    });
  }
}

test('falha de persistência do snapshot desfaz também o binding, sem request', async t => {
  const { db, id } = ambiente(t);
  db.db().exec(`CREATE TRIGGER falhar_snapshot BEFORE UPDATE OF sync_payload_v1 ON vendas
    BEGIN SELECT RAISE(ABORT, 'falha snapshot'); END`);
  const a = syncFalso(db);
  await assert.rejects(a.sync.retentarVendaManual(id), /falha snapshot/);
  assert.equal(linha(db, id).sync_protocolo, null);
  assert.equal(linha(db, id).sync_payload_v1, null);
  assert.deepEqual(a.chamadas, []);
});

test('migration adiciona coluna nullable e reabertura preserva snapshot existente', async t => {
  const { db, dir, id } = ambiente(t);
  db.db().exec('ALTER TABLE vendas DROP COLUMN sync_payload_v1');
  const atualizado = abrir(dir);
  t.after(() => atualizado.db().close());
  const coluna = atualizado.db().prepare('PRAGMA table_info(vendas)').all().find(c => c.name === 'sync_payload_v1');
  assert.equal(coluna.type, 'TEXT');
  assert.equal(coluna.notnull, 0);
  assert.equal(linha(atualizado, id).sync_payload_v1, null);
  await syncFalso(atualizado).sync.retentarVendaManual(id);
  const snapshot = linha(atualizado, id).sync_payload_v1;
  const novamente = abrir(dir);
  t.after(() => novamente.db().close());
  assert.equal(linha(novamente, id).sync_payload_v1, snapshot);
  assert.equal(linha(novamente, id).sync_protocolo, 'v1');
});

test('retry de orçamento usa a identidade remota congelada antes da RPC', async t => {
  const { db, id } = ambiente(t);
  db.db().prepare("INSERT INTO orcamentos (id,remote_id,numero,status,created_at) VALUES ('orc',?,1,'pendente','2026-09-21')").run(PRODUTO);
  db.db().prepare("UPDATE vendas SET orcamento_id='orc' WHERE id=?").run(id);
  const a = syncFalso(db, { v1: async () => ({ ok: false, motivo: 'rede' }) });
  await assert.rejects(a.sync.retentarVendaManual(id), /pendente/);
  db.db().prepare("UPDATE orcamentos SET remote_id='55555555-5555-4555-8555-555555555555'").run();
  const b = syncFalso(db);
  await b.sync.retentarVendaManual(id);
  assert.deepEqual(tipos(b.chamadas), ['arbitragem', 'v1']);
  assert.equal(b.chamadas[0][1].orcamento_id, PRODUTO);
  assert.equal(b.chamadas[1][1].payload.orcamento_id, PRODUTO);
});

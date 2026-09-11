const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

const Acoes = require('../src/renderer/lib/acoesOrcamento');

// FASE 0.6C.5.1 — O CRITÉRIO DE PROPRIEDADE DO ORÇAMENTO.
//
// O defeito: a tela tratava "existe linha local" como "tenho o documento".
//
// Medido no Escritório em 10/09/2026:
//   58 orçamentos locais · 55 com ZERO itens locais · todos os 58 com itens no
//   servidor · todos os 55 com podeEditar = true.
//
// O percurso da perda de dado, dois cliques: abrir o nº61 (criado no Balcão 02,
// cabeçalho baixado pelo down-sync, zero itens aqui) → Editar → o formulário
// abre com carrinho VAZIO → adicionar um produto → salvar. `atualizar()`
// enfileira, a rota autenticada sobe, e a RPC faz DELETE + INSERT dos itens.
// `revisao_base` local 0 == revisão remota 0, então o servidor ACEITA, e o
// orçamento perde os itens reais.
//
// A pergunta certa não é "existe linha?" — é "tenho os itens?".

const DDL = `
CREATE TABLE orcamentos (
  id TEXT PRIMARY KEY, remote_id TEXT UNIQUE, numero INTEGER,
  status TEXT DEFAULT 'pendente', cliente_nome TEXT,
  subtotal REAL DEFAULT 0, desconto REAL DEFAULT 0, total REAL DEFAULT 0,
  created_at TEXT NOT NULL, synced_at TEXT, sync_status TEXT DEFAULT 'synced',
  revisao_base INTEGER DEFAULT 0, conflito_em TEXT, op_chave TEXT
);
CREATE TABLE orcamento_itens (
  id TEXT PRIMARY KEY, orcamento_id TEXT, produto_id TEXT, produto_nome TEXT,
  produto_sku TEXT, quantidade REAL, preco_unitario REAL, desconto REAL, total REAL
);
CREATE TABLE sync_queue (
  id TEXT PRIMARY KEY, entidade TEXT, operacao TEXT, payload TEXT,
  tentativas INTEGER DEFAULT 0, erro TEXT, created_at TEXT, processado INTEGER DEFAULT 0
);
`;

function banco() { const sq = new DatabaseSync(':memory:'); sq.exec(DDL); return sq; }

function local(sq, o, itens = []) {
  sq.prepare(`INSERT INTO orcamentos (id, remote_id, numero, status, total, created_at, revisao_base)
    VALUES (?,?,?,?,?,?,?)`).run(o.id, o.remote_id ?? o.id, o.numero, o.status ?? 'aberto',
    o.total ?? 0, '2026-09-01T00:00:00.000Z', o.revisao_base ?? 0);
  itens.forEach((nome, i) => sq.prepare(`INSERT INTO orcamento_itens
    (id, orcamento_id, produto_nome, quantidade, preco_unitario, desconto, total)
    VALUES (?,?,?,1,10,0,10)`).run(`it-${o.id}-${i}`, o.id, nome));
}

/** O `getById` real: devolve a linha COM os itens que existirem. */
const getById = (sq, id) => {
  const o = sq.prepare('SELECT * FROM orcamentos WHERE id = ?').get(id);
  if (!o) return null;
  o.itens = sq.prepare('SELECT * FROM orcamento_itens WHERE orcamento_id = ?').all(id);
  return o;
};

/**
 * A classificação que a tela passa a fazer — a MESMA função de produção decide.
 * `lerAlheio` é injetado para cobrir online, offline e falha.
 */
async function classificar(sq, id, lerAlheio) {
  const localRow = getById(sq, id);
  if (Acoes.possuiItensLocais(localRow)) return { fluxo: 'local', orc: localRow, alheio: null };
  const snap = await lerAlheio(id);
  if (!snap || snap.tipo !== 'ok') return { fluxo: 'bloqueado', motivo: snap?.tipo ?? 'sem_resposta', local: localRow };
  return { fluxo: 'alheio', orc: { ...snap.dados, _origem: 'snapshot' }, alheio: { revisao: snap.dados.revisao } };
}

const snapshotDoServidor = (o) => async () => ({ tipo: 'ok', dados: o });
const offline = async () => ({ tipo: 'offline' });
const falha = async () => ({ tipo: 'erro', erro: 'HTTP 500' });

// ───────────────────────────────────────────────────────────────────────
describe('O DEFEITO — como era antes da 0.6C.5.1', () => {
  test('"existe linha" dava true para 55 cabeçalhos sem itens', () => {
    const sq = banco();
    local(sq, { id: 'b29d4bb2', numero: 61, total: 274.5 });   // nº61, sem itens
    const l = getById(sq, 'b29d4bb2');

    assert.ok(l, 'o critério antigo — "existe linha" — aprovava');
    assert.equal(l.itens.length, 0, 'e o documento não tinha um único item aqui');
    assert.equal(Acoes.podeEditar(l), true, 'a tela oferecia Editar');
    assert.equal(Acoes.podeConverter(l), true, 'e Converter em Venda');

    // O critério novo recusa exatamente este caso.
    assert.equal(Acoes.possuiItensLocais(l), false);
  });
});

describe('CASO A — linha local, zero itens, itens no servidor', () => {
  test('usa snapshot autenticado, NUNCA o fluxo local vazio', async () => {
    // ESTE TESTE FALHA NO CRITÉRIO ANTIGO: lá o fluxo seria 'local' com itens [].
    const sq = banco();
    local(sq, { id: 'b29d4bb2', numero: 61, total: 274.5 });
    const doServidor = {
      orcamento_id: 'b29d4bb2', numero: 61, status: 'aberto', revisao: 0, total: 274.5,
      itens: [{ produto_nome: 'CIMENTO', quantidade: 5, total: 194.5 },
        { produto_nome: 'AREIA', quantidade: 1, total: 80 }],
    };

    const r = await classificar(sq, 'b29d4bb2', snapshotDoServidor(doServidor));

    assert.equal(r.fluxo, 'alheio');
    assert.equal(r.orc._origem, 'snapshot');
    assert.equal(r.orc.itens.length, 2, 'os itens REAIS chegaram');
    assert.equal(r.alheio.revisao, 0, 'e a revisão do snapshot vira a base');
    assert.notEqual(r.fluxo, 'local');
  });
});

describe('CASO B — linha local com itens', () => {
  test('continua no fluxo offline-first, sem tocar na rede', async () => {
    const sq = banco();
    local(sq, { id: 'loc-1', numero: 60, total: 276.3 }, ['CIMENTO', 'GESSO']);
    let bateuNaRede = false;

    const r = await classificar(sq, 'loc-1', async () => { bateuNaRede = true; return null; });

    assert.equal(r.fluxo, 'local');
    assert.equal(bateuNaRede, false, 'documento próprio não depende de conexão');
    assert.equal(r.orc.itens.length, 2);
    assert.equal(r.alheio, null);
  });
});

describe('CASO C — sem linha local', () => {
  test('fluxo alheio, como já era na 0.6C.5', async () => {
    const sq = banco();
    const r = await classificar(sq, 'nunca-vi', snapshotDoServidor({
      orcamento_id: 'nunca-vi', numero: 7, status: 'cancelado', revisao: 0,
      itens: [{ produto_nome: 'PORTA', quantidade: 1, total: 529.99 }],
    }));
    assert.equal(r.fluxo, 'alheio');
    assert.equal(r.orc.itens.length, 1);
  });
});

describe('CASO D — sem itens locais e offline', () => {
  test('editar e converter ficam BLOQUEADOS, sem carrinho vazio', async () => {
    const sq = banco();
    local(sq, { id: 'b29d4bb2', numero: 61, total: 274.5 });

    const r = await classificar(sq, 'b29d4bb2', offline);

    assert.equal(r.fluxo, 'bloqueado');
    assert.equal(r.motivo, 'offline');
    assert.ok(r.local, 'o cabeçalho existe e pode ser MOSTRADO');
    assert.equal(r.orc, undefined, 'mas nenhum documento operável é devolvido');
  });

  test('o cabeçalho local, se exibido, não habilita ação', () => {
    const soCabecalho = { id: 'b29d4bb2', numero: 61, status: 'aberto', itens: [], _origem: 'cloud' };
    assert.equal(Acoes.podeEditar(soCabecalho), false);
    assert.equal(Acoes.podeConverter(soCabecalho), false);
    assert.equal(Acoes.podeCancelar(soCabecalho), false);
  });
});

describe('CASO E — sem itens locais e o snapshot falha', () => {
  test('nenhuma edição destrutiva fica possível', async () => {
    const sq = banco();
    local(sq, { id: 'b29d4bb2', numero: 61, total: 274.5 });
    const r = await classificar(sq, 'b29d4bb2', falha);
    assert.equal(r.fluxo, 'bloqueado');
    assert.equal(r.motivo, 'erro');
    assert.equal(r.orc, undefined);
  });
});

describe('CASO F — o nº61 real', () => {
  test('cabeçalho local, zero itens, snapshot traz os itens do servidor', async () => {
    // Valores reais: criado no Balcão 02 em 10/09 19:01, R$ 274,50.
    const sq = banco();
    local(sq, { id: 'b29d4bb2-ba95-4953-a81f-a6dca2a5406d',
      remote_id: 'b29d4bb2-ba95-4953-a81f-a6dca2a5406d', numero: 61, total: 274.5 });

    assert.equal(sq.prepare('SELECT COUNT(*) n FROM orcamento_itens').get().n, 0);

    const r = await classificar(sq, 'b29d4bb2-ba95-4953-a81f-a6dca2a5406d', snapshotDoServidor({
      orcamento_id: 'b29d4bb2-ba95-4953-a81f-a6dca2a5406d', numero: 61,
      status: 'aberto', revisao: 0, total: 274.5,
      itens: [{ produto_nome: 'item real do Balcão 02', quantidade: 1, total: 274.5 }],
    }));

    assert.equal(r.fluxo, 'alheio');
    assert.equal(r.orc.numero, 61);
    assert.equal(r.orc.itens.length, 1);
    assert.equal(sq.prepare('SELECT COUNT(*) n FROM orcamento_itens').get().n, 0,
      'e abrir NÃO persistiu item nenhum');
    assert.equal(sq.prepare('SELECT COUNT(*) n FROM orcamentos').get().n, 1, 'nem criou linha');
    assert.equal(sq.prepare('SELECT COUNT(*) n FROM sync_queue').get().n, 0, 'nem mexeu na fila');
  });
});

describe('CASO G — salvar depois do snapshot', () => {
  test('a revisão vem do snapshot e os itens são os reais, não um carrinho parcial', async () => {
    const sq = banco();
    local(sq, { id: 'b29d4bb2', numero: 61, total: 274.5, revisao_base: 0 });
    const r = await classificar(sq, 'b29d4bb2', snapshotDoServidor({
      orcamento_id: 'b29d4bb2', numero: 61, status: 'aberto', revisao: 4, total: 274.5,
      itens: [{ produto_nome: 'CIMENTO', quantidade: 5, total: 194.5 },
        { produto_nome: 'AREIA', quantidade: 1, total: 80 }],
    }));

    // A operação que subiria: base do SNAPSHOT (4), não do palpite local (0).
    assert.equal(r.alheio.revisao, 4);
    assert.notEqual(r.alheio.revisao, getById(sq, 'b29d4bb2').revisao_base);
    assert.equal(r.orc.itens.length, 2, 'o formulário parte dos itens reais');

    // O defeito era exatamente isto: partir de zero e mandar zero + um.
    assert.notEqual(r.orc.itens.length, 0);
  });
});

describe('CASO H — regressão: documento criado neste terminal', () => {
  test('nada muda para quem tem os itens aqui', async () => {
    const sq = banco();
    local(sq, { id: '1a4ca66e', numero: 60, total: 276.3, revisao_base: 3, status: 'pendente' },
      ['CIMENTO CP-3 40 VOTORAM 50KG', 'GESSO RAPIDO 1KG']);

    const r = await classificar(sq, '1a4ca66e', async () => {
      throw new Error('não deveria consultar a rede para documento próprio');
    });

    assert.equal(r.fluxo, 'local');
    assert.equal(r.orc.revisao_base, 3, 'a revisão local continua sendo a base');
    assert.equal(r.orc.itens.length, 2);
    assert.equal(Acoes.podeEditar(r.orc), true);
    assert.equal(Acoes.podeConverter(r.orc), true, 'documento próprio continua conversível');
    assert.equal(Acoes.podeCancelar(r.orc), true);
  });

  test('os três predicados seguem valendo para snapshot alheio', () => {
    const snap = { status: 'aberto', _origem: 'snapshot', itens: [{}], revisao: 4 };
    assert.equal(Acoes.podeEditar(snap), true);
    assert.equal(Acoes.podeCancelar(snap), true);
    assert.equal(Acoes.podeConverter(snap), false, 'conversão alheia segue bloqueada — D-a');
  });
});

describe('A REGRA MORA NUM LUGAR SÓ', () => {
  test('possuiItensLocais é o único juiz, e é explícito', () => {
    assert.equal(Acoes.possuiItensLocais(null), false);
    assert.equal(Acoes.possuiItensLocais({}), false, 'sem campo itens');
    assert.equal(Acoes.possuiItensLocais({ itens: [] }), false, 'cabeçalho puro');
    assert.equal(Acoes.possuiItensLocais({ itens: null }), false);
    assert.equal(Acoes.possuiItensLocais({ itens: [{ produto_nome: 'x' }] }), true);
  });
});

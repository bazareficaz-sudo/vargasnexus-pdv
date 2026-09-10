const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { criarComandoOrcamento } = require('../src/main/orcamentoComando');
const orcSql = require('../src/main/orcamentoSql');
const Identidade = require('../src/renderer/lib/identidadeOrcamento');

// FASE 0.6C.2 — O NÚMERO OFICIAL É DO SERVIDOR.
//
// O defeito, medido em produção em 09/09/2026: o PDV criou um orçamento com
// número provisório 59, o servidor gravou o mesmo documento como nº 60, e a
// tela passou a mostrar DUAS linhas — #59 (local) e #60 ("outro terminal") —
// para uma única linha no Postgres e uma única no SQLite.
//
// Nada estava duplicado no banco. O que duplicava era a leitura: a lista
// juntava local e cloud usando o `numero` como chave, e o número tinha duas
// versões porque ninguém nunca reconciliava a estimativa local.
//
// Estes testes rodam o SQL DE VERDADE (`node:sqlite`, mesmo motor, mesmas
// strings que `database.js` executa) e a função de merge DE VERDADE, a mesma
// que a tela carrega. Não há cópia parecida do comportamento em lugar nenhum.

// Espelha o schema que `database.js` cria (base + migrations 0.6C.1).
// Se ele divergir, estes testes quebram — que é o comportamento desejado.
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

/**
 * SQLite real com um orçamento local já criado, como `registrar()` deixa:
 * número provisório, sem remote_id, sync_status 'pending', um item.
 */
function bancoReal(over = {}, arquivo = ':memory:') {
  const sq = new DatabaseSync(arquivo);
  sq.exec(DDL);
  const orc = {
    id: 'loc-1', remote_id: null, numero: 59, status: 'pendente',
    sync_status: 'pending', revisao_base: 0, op_chave: null,
    total: 194.5, subtotal: 194.5, desconto: 0,
    created_at: '2026-09-09T23:27:47.404Z', cliente_nome: 'Eliane',
    ...over,
  };
  sq.prepare(`INSERT INTO orcamentos
    (id, remote_id, numero, status, sync_status, revisao_base, op_chave,
     subtotal, desconto, total, created_at, cliente_nome)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    orc.id, orc.remote_id, orc.numero, orc.status, orc.sync_status,
    orc.revisao_base, orc.op_chave, orc.subtotal, orc.desconto, orc.total,
    orc.created_at, orc.cliente_nome);
  sq.prepare(`INSERT INTO orcamento_itens
    (id, orcamento_id, produto_nome, quantidade, preco_unitario, desconto, total)
    VALUES (?,?,?,?,?,?,?)`)
    .run('it-1', orc.id, 'CIMENTO CP-3 40 VOTORAM 50KG', 5, 38.9, 0, 194.5);
  return sq;
}

const linha = (sq, id = 'loc-1') => sq.prepare('SELECT * FROM orcamentos WHERE id = ?').get(id);
const linhas = (sq) => sq.prepare('SELECT * FROM orcamentos ORDER BY numero').all();
const itens = (sq, id = 'loc-1') => sq.prepare('SELECT * FROM orcamento_itens WHERE orcamento_id = ?').all(id);

/** As dependências do orquestrador, mas gravando no SQLite real acima. */
function dbSobre(sq) {
  const fila = [{ id: 'q1', processado: 0 }];
  return {
    _fila: fila,
    orcamentos: {
      getById: (id) => linha(sq, id),
      payloadSync: (id) => ({ ...linha(sq, id), itens: itens(sq, id) }),
      marcarOperacaoPendente: (id, chave) =>
        sq.prepare('UPDATE orcamentos SET op_chave = ? WHERE id = ? AND op_chave IS NULL').run(chave, id),
      // O MESMO SQL que database.js executa.
      confirmarSincronizacao: (id, dados) =>
        sq.prepare(orcSql.SQL_CONFIRMAR_SINCRONIZACAO)
          .run(...orcSql.paramsConfirmar(id, dados, new Date().toISOString())),
      marcarConflito: (id) =>
        sq.prepare("UPDATE orcamentos SET sync_status='conflito', conflito_em=?, op_chave=NULL WHERE id=?")
          .run('agora', id),
    },
    sync: { concluirPendentesDeOrcamento: () => { fila.forEach(f => { f.processado = 1; }); } },
  };
}

function apiFalsa(resposta) {
  const chamadas = [];
  return {
    chamadas, legado: [],
    salvarOrcamentoAutenticado: async (cmd) => { chamadas.push(cmd); return resposta; },
    montarPayloadOrcamentoRemoto: (p) => p,
    sincronizarOrcamento: async function (p) {
      this.legado.push(p);
      // O insert legado devolve a linha gravada — com o número do servidor.
      return { id: 'uuid-do-servidor', numero: 60 };
    },
    atualizarOrcamento: async function (rid, d) { this.legado.push([rid, d]); return { ok: true }; },
    atualizarStatusOrcamento: async function (rid, s) { this.legado.push([rid, s]); return { ok: true }; },
  };
}

const terminalFalso = () => ({
  fallbacks: [],
  registrarFallback: async function (op, chave, motivo) { this.fallbacks.push({ op, chave, motivo }); },
});
const mudo = { log() {}, warn() {}, error() {} };
const OK = (over = {}) => ({ tipo: 'ok', dados: { orcamento_id: 'loc-1', numero: 60, revisao: 1, ...over } });

// ───────────────────────────────────────────────────────────────────────
describe('1. o defeito exato: provisório 59 → oficial 60', () => {
  test('a linha local passa a nº60, mesma linha, mesma identidade', async () => {
    // ESTE TESTE FALHA NO CÓDIGO ANTERIOR À 0.6C.2: `confirmarSincronizacao`
    // gravava remote_id e revisao_base e descartava o número do servidor.
    const sq = bancoReal();
    const db = dbSobre(sq);
    const api = apiFalsa(OK());
    assert.equal(linha(sq).numero, 59, 'começa com o palpite local');

    const r = await criarComandoOrcamento({ db, api, terminal: terminalFalso(), log: mudo })
      .executar('loc-1', 'salvar');

    const l = linha(sq);
    assert.equal(r.tipo, 'ok');
    assert.equal(l.numero, 60, 'passou a valer o número do servidor');
    assert.equal(l.id, 'loc-1', 'o id local NÃO muda');
    assert.equal(l.remote_id, 'loc-1', 'remote_id convergiu para o id local');
    assert.equal(l.revisao_base, 1);
    assert.equal(l.op_chave, null, 'operação encerrada');
    assert.equal(l.sync_status, 'synced');
    assert.equal(linhas(sq).length, 1, 'UMA linha — nenhuma foi criada');
    assert.equal(itens(sq).length, 1, 'itens intactos');
    assert.equal(db._fila[0].processado, 1);
  });

  test('e a tela passa a mostrar UM orçamento', () => {
    // O outro lado do mesmo defeito: mesmo antes de reconciliar, a lista não
    // pode contar o mesmo documento duas vezes.
    const locais = [{ id: 'loc-1', remote_id: 'loc-1', numero: 59, total: 194.5 }];
    const cloud = [{ id: 'loc-1', remote_id: 'loc-1', numero: 60, total: 194.5 }];
    const lista = Identidade.mesclar(locais, cloud);
    assert.equal(lista.length, 1, 'um documento, uma linha');
    assert.equal(lista[0].numero, 60, 'e com o número oficial');
    assert.equal(lista[0]._origem, 'sync', 'a linha local vence: ela tem os dados');
  });
});

describe('2. o número sobrevive ao fechamento do Electron', () => {
  test('reabrir o arquivo mantém nº60', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orc-0.6c2-'));
    const arquivo = path.join(dir, 'pdv.db');
    try {
      const sq = bancoReal({}, arquivo);
      await criarComandoOrcamento({ db: dbSobre(sq), api: apiFalsa(OK()), terminal: terminalFalso(), log: mudo })
        .executar('loc-1', 'salvar');
      sq.close();                                   // app fechado

      const sq2 = new DatabaseSync(arquivo);        // app reaberto
      const l = sq2.prepare('SELECT * FROM orcamentos WHERE id = ?').get('loc-1');
      assert.equal(l.numero, 60, 'está no disco, não só em memória');
      assert.equal(l.revisao_base, 1);
      assert.equal(l.remote_id, 'loc-1');
      sq2.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('3. o COALESCE protege o que já está gravado', () => {
  for (const [rotulo, valor] of [
    ['ausente', undefined], ['null', null], ['zero', 0],
    ['texto', 'sessenta'], ['fracionário', 60.5],
  ]) {
    test(`número ${rotulo} vindo do servidor NÃO apaga o número local`, async () => {
      const sq = bancoReal();
      await criarComandoOrcamento({
        db: dbSobre(sq), api: apiFalsa(OK({ numero: valor })), terminal: terminalFalso(), log: mudo,
      }).executar('loc-1', 'salvar');
      assert.equal(linha(sq).numero, 59, 'preserva, não zera');
      assert.equal(linha(sq).revisao_base, 1, 'e o resto da confirmação vale');
    });
  }

  test('edição não renumera: servidor devolve o mesmo número', async () => {
    const sq = bancoReal({ remote_id: 'loc-1', numero: 60, revisao_base: 1, sync_status: 'synced' });
    await criarComandoOrcamento({
      db: dbSobre(sq), api: apiFalsa(OK({ numero: 60, revisao: 2 })), terminal: terminalFalso(), log: mudo,
    }).executar('loc-1', 'salvar');
    const l = linha(sq);
    assert.equal(l.numero, 60, 'número é imutável depois de criar');
    assert.equal(l.revisao_base, 2, 'só a revisão anda');
  });

  test('conflito não mexe no número', async () => {
    const sq = bancoReal({ remote_id: 'loc-1', numero: 60, revisao_base: 1 });
    await criarComandoOrcamento({
      db: dbSobre(sq), api: apiFalsa({ tipo: 'conflito', erro: 'conflito_versao' }), terminal: terminalFalso(), log: mudo,
    }).executar('loc-1', 'salvar');
    assert.equal(linha(sq).numero, 60);
    assert.equal(linha(sq).sync_status, 'conflito');
  });

  test('erro de rede não mexe no número nem na chave', async () => {
    const sq = bancoReal();
    await criarComandoOrcamento({
      db: dbSobre(sq), api: apiFalsa({ tipo: 'erro', motivo: 'rede', erro: 'timeout' }), terminal: terminalFalso(), log: mudo,
    }).executar('loc-1', 'salvar');
    assert.equal(linha(sq).numero, 59, 'segue provisório até alguém confirmar');
    assert.equal(linha(sq).op_chave, 'loc-1:r0:salvar', 'chave viva para o retry');
  });
});

describe('4. o caminho legado reconcilia igual', () => {
  test('rota desligada: grava pelo legado e adota o número que ele devolveu', async () => {
    // Se só a rota nova reconciliasse, a divergência voltaria pelo lado que
    // ainda usa o `anon` — que é a maior parte da frota hoje.
    const sq = bancoReal();
    const api = apiFalsa({ tipo: 'legado', motivo: 'rota_desligada' });
    const term = terminalFalso();
    const r = await criarComandoOrcamento({ db: dbSobre(sq), api, terminal: term, log: mudo })
      .executar('loc-1', 'salvar');

    assert.equal(r.tipo, 'legado');
    assert.equal(term.fallbacks.length, 1, 'fallback continua sendo contado');
    const l = linha(sq);
    assert.equal(l.numero, 60, 'número oficial do insert legado');
    assert.equal(l.remote_id, 'uuid-do-servidor', 'legado gera id próprio');
    assert.equal(l.id, 'loc-1', 'e o id local segue intacto');
    assert.equal(linhas(sq).length, 1);
  });

  test('orçamento nascido no legado continua sendo localizado por remote_id', async () => {
    const sq = bancoReal({ remote_id: 'uuid-antigo', numero: 58, sync_status: 'synced' });
    const api = apiFalsa(OK({ orcamento_id: 'uuid-antigo', numero: 59, revisao: 1 }));
    await criarComandoOrcamento({ db: dbSobre(sq), api, terminal: terminalFalso(), log: mudo })
      .executar('loc-1', 'salvar');

    assert.equal(api.chamadas[0].orcamento_id, 'uuid-antigo', 'identidade efetiva preservada');
    assert.equal(api.chamadas[0].idempotency_key, 'uuid-antigo:r0:salvar');
    const l = linha(sq);
    assert.equal(l.id, 'loc-1', 'id local intacto');
    assert.equal(l.remote_id, 'uuid-antigo', 'remote_id intacto — não vira o id local');
    assert.equal(l.numero, 59, 'e o número defasado (58) é corrigido');
  });
});

describe('5. down-sync alinha o número sem tocar na identidade', () => {
  const doCloud = (over = {}) => ({
    id: 'loc-1', remote_id: 'loc-1', numero: 60, status: 'aberto',
    cliente_nome: 'Eliane', total: 194.5, created_at: '2026-09-09T23:27:47.551Z', ...over,
  });
  // 0.6C.3: a descida passou a resolver identidade e a isolar cada linha.
  const baixar = (sq, lista) => orcSql.reconciliarDoCloud(sq, lista, new Date().toISOString());

  test('mesmo id: atualiza número e status, preserva tudo que é identidade', () => {
    const sq = bancoReal({ remote_id: 'loc-1', numero: 59, sync_status: 'synced', revisao_base: 1 });
    baixar(sq, [doCloud()]);

    const l = linha(sq);
    assert.equal(linhas(sq).length, 1, 'não recriou linha');
    assert.equal(l.id, 'loc-1', 'id preservado');
    assert.equal(l.remote_id, 'loc-1', 'remote_id preservado');
    assert.equal(l.numero, 60, 'número alinhado');
    assert.equal(l.status, 'pendente', '0.6C.3: o status local NÃO é sobrescrito — ver orcamentoSql.js');
    assert.equal(l.revisao_base, 1, 'revisão preservada — o cloud não a conhece');
    assert.equal(l.created_at, '2026-09-09T23:27:47.404Z', 'created_at local preservado');
    assert.equal(itens(sq).length, 1, 'itens não são tocados pelo cabeçalho');
  });

  test('número nulo no cloud não zera o número local', () => {
    const sq = bancoReal({ remote_id: 'loc-1', numero: 60, sync_status: 'synced' });
    baixar(sq, [doCloud({ numero: null })]);
    assert.equal(linha(sq).numero, 60);
  });

  test('linha com edição local pendente NÃO é sobrescrita', () => {
    // Proteção que já existia e não pode ter sido perdida na mudança.
    const sq = bancoReal({ remote_id: 'loc-1', numero: 59, sync_status: 'pending' });
    const r = baixar(sq, [doCloud({ numero: 60, status: 'cancelado' })]);
    const l = linha(sq);
    assert.equal(l.numero, 59, 'o que ainda não subiu não é atropelado');
    assert.equal(l.status, 'pendente');
    assert.equal(l.sync_status, 'pending');
    assert.equal(r.preservados, 1, 'e a preservação é contada, não muda');
  });

  test('documento de outro terminal é inserido, não confundido com o local', () => {
    const sq = bancoReal({ remote_id: 'loc-1', sync_status: 'synced' });
    baixar(sq, [doCloud({ id: 'outro', remote_id: 'outro', numero: 61 })]);
    assert.equal(linhas(sq).length, 2);
    assert.equal(linha(sq, 'outro').numero, 61);
    assert.equal(linha(sq, 'loc-1').id, 'loc-1');
  });
});

describe('6. merge da tela: identidade, não número', () => {
  test('legado com id_local ≠ remote_id casa com o cloud e exibe o número oficial', () => {
    // O caso real do nº58: local d87547a7 (número 58) é o documento que o
    // servidor chama de ee29e3b9, nº59. Pelo número seriam duas linhas.
    const locais = [{ id: 'd87547a7', remote_id: 'ee29e3b9', numero: 58, total: 389 }];
    const cloud = [{ id: 'ee29e3b9', remote_id: 'ee29e3b9', numero: 59, total: 389 }];
    const lista = Identidade.mesclar(locais, cloud);
    assert.equal(lista.length, 1);
    assert.equal(lista[0].id, 'd87547a7', 'a linha local vence, com seus dados');
    assert.equal(lista[0].numero, 59, 'mas o número é o do servidor');
  });

  test('documentos DIFERENTES com o mesmo número continuam DOIS', () => {
    // Pela chave antiga, este é o caso grave: um esconderia o outro.
    const locais = [{ id: 'novo', remote_id: 'novo', numero: 59, total: 194.5 }];
    const cloud = [{ id: 'ee29e3b9', remote_id: 'ee29e3b9', numero: 59, total: 389 }];
    const lista = Identidade.mesclar(locais, cloud);
    assert.equal(lista.length, 2, 'nenhum documento desaparece');
    assert.deepEqual(lista.map(o => o.id).sort(), ['ee29e3b9', 'novo']);

    const porNumero = new Map();
    for (const o of cloud) porNumero.set(String(o.numero), o);
    for (const o of locais) porNumero.set(String(o.numero), o);
    assert.equal(porNumero.size, 1, 'a chave antiga perdia um — é o defeito estrutural');
  });

  test('orçamento ainda não sincronizado aparece uma vez, marcado como local', () => {
    const lista = Identidade.mesclar([{ id: 'loc-9', remote_id: null, numero: 61 }], []);
    assert.equal(lista.length, 1);
    assert.equal(lista[0]._origem, 'local');
    assert.equal(lista[0].numero, 61, 'sem par no cloud, o provisório é o que há');
  });

  test('documento só do cloud continua marcado como "outro terminal"', () => {
    const lista = Identidade.mesclar([], [{ id: 'r-7', remote_id: 'r-7', numero: 7 }]);
    assert.equal(lista.length, 1);
    assert.equal(lista[0]._origem, 'cloud');
  });

  test('a chave nunca é o número, nem quando o número existe', () => {
    assert.equal(Identidade.chaveDeIdentidade({ id: 'a', remote_id: 'b', numero: 9 }), 'b');
    assert.equal(Identidade.chaveDeIdentidade({ id: 'a', remote_id: null, numero: 9 }), 'a');
  });
});

describe('PROVA POR CONTRADIÇÃO — o estado exato medido em produção', () => {
  test('os 3 documentos de 09/09 rendem 3 linhas, não 4', () => {
    // Reprodução do que foi medido: 57 locais, 57 no cloud, 59 linhas na tela.
    // Aqui, o recorte que continha a divergência.
    const locais = [
      { id: 'a4d09df2', remote_id: 'a4d09df2', numero: 57, total: 158.8 },   // ok desde sempre
      { id: 'd87547a7', remote_id: 'ee29e3b9', numero: 58, total: 389 },     // nasceu no legado
      { id: '1a4ca66e', remote_id: '1a4ca66e', numero: 59, total: 194.5 },   // provisório
    ];
    const cloud = [
      { id: 'a4d09df2', remote_id: 'a4d09df2', numero: 57, total: 158.8 },
      { id: 'ee29e3b9', remote_id: 'ee29e3b9', numero: 59, total: 389 },
      { id: '1a4ca66e', remote_id: '1a4ca66e', numero: 60, total: 194.5 },   // oficial
    ];

    const antigo = new Map();
    for (const o of cloud) antigo.set(String(o.numero), o);
    for (const o of locais) antigo.set(String(o.numero), o);
    assert.equal(antigo.size, 4, 'chave = numero: 4 linhas para 3 documentos');

    const lista = Identidade.mesclar(locais, cloud);
    assert.equal(lista.length, 3, 'chave = identidade: 3 linhas para 3 documentos');
    assert.deepEqual(lista.map(o => o.numero).sort((a, b) => a - b), [57, 59, 60],
      'e cada uma com o número que o servidor atribuiu');
  });
});

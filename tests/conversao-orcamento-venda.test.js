const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');

// FASE 0.6C.6A — O VÍNCULO ORÇAMENTO → VENDA.
//
// Estes testes cobrem o que roda DENTRO do SQLite. As provas de ponta a ponta
// — dois terminais independentes, arbitragem do Postgres, estado da perdedora —
// estão no relatório da fase, feitas contra o `database.js` real e a RPC real.
//
// O que se prova aqui é o mecanismo local, com a MESMA DDL da migration:
//
//   1. o índice único permite muitos NULL e barra o segundo vínculo;
//   2. a violação dentro da transação desfaz TAMBÉM o estoque;
//   3. a perdedora fica distinguível de uma venda que só não subiu.
//
// E o que NÃO se prova aqui, de propósito: nada disto impede dois terminais.
// Bancos independentes não se enxergam. Ver o teste do fim.

const DDL = `
CREATE TABLE vendas (
  id TEXT PRIMARY KEY, remote_id TEXT, numero INTEGER, status TEXT,
  total REAL, created_at TEXT, sync_status TEXT DEFAULT 'pending',
  orcamento_id TEXT, conflito_conversao TEXT
);
CREATE TABLE venda_itens (
  id TEXT PRIMARY KEY, venda_id TEXT, produto_id TEXT, quantidade REAL
);
CREATE TABLE estoque (produto_id TEXT PRIMARY KEY, quantidade REAL);
CREATE TABLE movimentacoes_estoque (id TEXT PRIMARY KEY, produto_id TEXT, quantidade REAL);
CREATE TABLE orcamentos (
  id TEXT PRIMARY KEY, numero INTEGER, status TEXT, venda_id TEXT, sync_status TEXT
);
CREATE TABLE sync_queue (
  id TEXT PRIMARY KEY, entidade TEXT, operacao TEXT, payload TEXT,
  created_at TEXT, processado INTEGER DEFAULT 0
);
-- A MESMA instrução da migration em database.js.
CREATE UNIQUE INDEX vendas_orcamento_unico
    ON vendas (orcamento_id) WHERE orcamento_id IS NOT NULL;
`;

function terminal() {
  const sq = new DatabaseSync(':memory:');
  sq.exec(DDL);
  sq.prepare('INSERT INTO estoque VALUES (?,?)').run('p1', 100);
  sq.prepare("INSERT INTO orcamentos VALUES ('X', 60, 'pendente', NULL, 'synced')").run();
  return sq;
}

/** A forma da transação de `vendas.registrar`: venda, item, estoque, mov, fila, vínculo. */
function registrarVenda(sq, { id, orcamento_id, qtd = 7 }) {
  const tx = () => {
    sq.exec('SAVEPOINT v');
    try {
      sq.prepare(`INSERT INTO vendas (id,numero,status,total,created_at,sync_status,orcamento_id)
                  VALUES (?,?,?,?,?,?,?)`).run(id, 1, 'concluida', 10, 'agora', 'pending', orcamento_id ?? null);
      sq.prepare('INSERT INTO venda_itens VALUES (?,?,?,?)').run(`i-${id}`, id, 'p1', qtd);
      sq.prepare('UPDATE estoque SET quantidade = quantidade - ? WHERE produto_id = ?').run(qtd, 'p1');
      sq.prepare('INSERT INTO movimentacoes_estoque VALUES (?,?,?)').run(`m-${id}`, 'p1', -qtd);
      sq.prepare(`INSERT INTO sync_queue (id,entidade,operacao,payload,created_at)
                  VALUES (?,?,?,?,?)`).run(`q-${id}`, 'venda', 'create', JSON.stringify({ venda_id: id }), 'agora');
      if (orcamento_id) {
        sq.prepare(`UPDATE orcamentos SET status='convertido', venda_id=?, sync_status='pending'
                     WHERE id=?`).run(id, orcamento_id);
        sq.prepare(`INSERT INTO sync_queue (id,entidade,operacao,payload,created_at)
                    VALUES (?,?,?,?,?)`).run(`qc-${id}`, 'orcamento_converter', 'converter',
          JSON.stringify({ orcamento_id, venda_id: id }), 'agora');
      }
      sq.exec('RELEASE v');
    } catch (e) {
      sq.exec('ROLLBACK TO v'); sq.exec('RELEASE v');
      throw e;
    }
  };
  tx();
  return id;
}

const estoque = (sq) => sq.prepare("SELECT quantidade q FROM estoque WHERE produto_id='p1'").get().q;
const vendas = (sq) => sq.prepare('SELECT COUNT(*) n FROM vendas').get().n;

// ───────────────────────────────────────────────────────────────────────
describe('1. o vínculo nasce com a venda, na mesma transação', () => {
  test('venda + itens + estoque + fila + orçamento convertido, tudo junto', () => {
    const sq = terminal();
    registrarVenda(sq, { id: 'vA', orcamento_id: 'X' });

    const v = sq.prepare("SELECT * FROM vendas WHERE id='vA'").get();
    const o = sq.prepare("SELECT * FROM orcamentos WHERE id='X'").get();
    assert.equal(v.orcamento_id, 'X', 'o vínculo está na venda');
    assert.equal(o.status, 'convertido');
    assert.equal(o.venda_id, 'vA', 'e o inverso no orçamento');
    assert.equal(estoque(sq), 93);
    assert.equal(sq.prepare("SELECT COUNT(*) n FROM sync_queue WHERE entidade='orcamento_converter'").get().n, 1,
      'a fila avisa o servidor — a conversão não depende de ninguém lembrar');
  });
});

describe('2. duplo clique NO MESMO TERMINAL', () => {
  test('o segundo é recusado e NÃO baixa estoque', () => {
    // ESTE TESTE FALHA SEM O ÍNDICE ÚNICO: as duas vendas entram e o estoque
    // cai duas vezes. Foi o que aconteceu quatro vezes em produção.
    const sq = terminal();
    registrarVenda(sq, { id: 'vA', orcamento_id: 'X' });
    const depoisDoPrimeiro = estoque(sq);

    assert.throws(() => registrarVenda(sq, { id: 'vB', orcamento_id: 'X' }),
      (e) => /UNIQUE|constraint/i.test(e.message));

    assert.equal(estoque(sq), depoisDoPrimeiro, 'o rollback desfez a baixa do segundo');
    assert.equal(vendas(sq), 1, 'uma venda só');
    assert.equal(sq.prepare('SELECT COUNT(*) n FROM movimentacoes_estoque').get().n, 1);
    assert.equal(sq.prepare('SELECT COUNT(*) n FROM venda_itens').get().n, 1);
  });

  test('o índice não atrapalha vendas sem orçamento', () => {
    // Regressão: `UNIQUE` parcial permite quantos NULL quiser.
    const sq = terminal();
    registrarVenda(sq, { id: 'v1' });
    registrarVenda(sq, { id: 'v2' });
    registrarVenda(sq, { id: 'v3' });
    assert.equal(vendas(sq), 3, 'venda comum continua funcionando igual');
    assert.equal(sq.prepare("SELECT COUNT(*) n FROM orcamentos WHERE status='convertido'").get().n, 0);
    assert.equal(sq.prepare("SELECT COUNT(*) n FROM sync_queue WHERE entidade='orcamento_converter'").get().n, 0,
      'e não inventa item de conversão');
  });
});

describe('3. a perdedora fica distinguível', () => {
  function marcarConflito(sq, vendaId, detalhe) {
    sq.prepare(`UPDATE vendas SET sync_status='conflito_orcamento', conflito_conversao=?
                 WHERE id=?`).run(JSON.stringify({ ...detalhe, ocorrido_em: 'agora' }), vendaId);
  }

  test('sai de "pendente" e diz quem ganhou', () => {
    const sq = terminal();
    registrarVenda(sq, { id: 'vB', orcamento_id: 'X' });

    marcarConflito(sq, 'vB', {
      tipo: 'conflito_orcamento', orcamento_id: 'X', numero_orcamento: 60,
      venda_local_id: 'vB', venda_vencedora_id: 'vA-de-outro-terminal',
    });

    const v = sq.prepare("SELECT * FROM vendas WHERE id='vB'").get();
    assert.equal(v.sync_status, 'conflito_orcamento');
    assert.notEqual(v.sync_status, 'pending', 'não se confunde com "esperando internet"');
    assert.equal(sq.prepare("SELECT COUNT(*) n FROM vendas WHERE sync_status='pending'").get().n, 0);

    const d = JSON.parse(v.conflito_conversao);
    assert.equal(d.venda_vencedora_id, 'vA-de-outro-terminal', 'suporte sabe qual venda valeu');
    assert.equal(d.numero_orcamento, 60);
  });

  test('nada é apagado e nada é desfeito automaticamente', () => {
    const sq = terminal();
    registrarVenda(sq, { id: 'vB', orcamento_id: 'X' });
    const estoqueAposVenda = estoque(sq);
    marcarConflito(sq, 'vB', { tipo: 'conflito_orcamento', venda_vencedora_id: 'vA' });

    assert.equal(vendas(sq), 1, 'a venda continua existindo');
    assert.equal(sq.prepare('SELECT COUNT(*) n FROM venda_itens').get().n, 1, 'os itens também');
    assert.equal(estoque(sq), estoqueAposVenda,
      'o estoque NÃO é compensado automaticamente — é decisão comercial, não técnica');
    assert.equal(sq.prepare('SELECT COUNT(*) n FROM movimentacoes_estoque').get().n, 1,
      'e a movimentação fica registrada, não sumindo do histórico');
  });
});

describe('4. O QUE O ÍNDICE LOCAL NÃO FAZ', () => {
  test('dois terminais convertem o mesmo orçamento — e os DOIS commitam', () => {
    // Dois bancos SEPARADOS, como na vida real. Um índice único não enxerga o
    // outro arquivo. Se este teste um dia "passar a impedir", é porque alguém
    // simulou os dois terminais numa conexão só — e a prova seria falsa.
    const A = terminal();
    const B = terminal();

    registrarVenda(A, { id: 'vA', orcamento_id: 'X' });
    registrarVenda(B, { id: 'vB', orcamento_id: 'X' });

    assert.equal(vendas(A), 1);
    assert.equal(vendas(B), 1);
    assert.equal(A.prepare("SELECT venda_id v FROM orcamentos WHERE id='X'").get().v, 'vA');
    assert.equal(B.prepare("SELECT venda_id v FROM orcamentos WHERE id='X'").get().v, 'vB');
    assert.equal(estoque(A), 93, 'A baixou estoque');
    assert.equal(estoque(B), 93, 'e B também — nada local impede isso');

    // A arbitragem entre terminais é do Postgres, em `orcamentos.venda_id`,
    // com compare-and-set. Aqui só se documenta que ela NÃO é local.
  });
});

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { criarComandoOrcamento } = require('../src/main/orcamentoComando');

// TESTES DO CAMINHO REAL — o que faltou e derrubou o primeiro piloto.
//
// A suíte anterior cobria validação, idempotência, flag e a RPC, e provou a
// transação contra o banco. Nenhum teste exercitava COMO O PDV CHAMA — e foi
// por isso que "690 testes verdes" conviveu com um orçamento gravado pelo
// legado com a flag ligada.
//
// Aqui os duplos são do transporte e do estado local. O que está sob teste é
// a orquestração: quem decide rota, chave, revisão, fila e fallback.

/** Um SQLite de mentira, com só o que o comando usa. */
function bancoFalso(orcInicial = {}) {
  const orc = {
    id: 'loc-1', remote_id: null, revisao_base: 0, op_chave: null,
    status: 'pendente', sync_status: 'pending', conflito_em: null,
    subtotal: 100, desconto: 0, total: 100, cliente_nome: 'João',
    vendedor_nome: 'Eliane', validade_dias: 7, observacao: null,
    ...orcInicial,
  };
  const fila = [{ id: 'q1', orcamento_id: orc.id, processado: 0 }];
  return {
    _orc: orc, _fila: fila,
    orcamentos: {
      getById: () => ({ ...orc }),
      payloadSync: () => ({ ...orc, itens: [{ produto_nome: 'Cimento', quantidade: 10, preco_unitario: 38.9, total: 389 }] }),
      marcarOperacaoPendente: (_id, chave) => { if (!orc.op_chave) orc.op_chave = chave; },
      confirmarSincronizacao: (_id, { remote_id, revisao }) => {
        if (remote_id) orc.remote_id = remote_id;
        if (revisao != null) orc.revisao_base = Number(revisao);
        orc.sync_status = 'synced'; orc.op_chave = null; orc.conflito_em = null;
      },
      marcarConflito: () => { orc.sync_status = 'conflito'; orc.conflito_em = 'agora'; orc.op_chave = null; },
      atualizarRemoteId: (_id, rid) => { orc.remote_id = rid; },
    },
    sync: {
      concluirPendentesDeOrcamento: () => { fila.forEach(f => { f.processado = 1; }); },
    },
  };
}

/** Transporte de mentira: grava as chamadas e devolve o que o teste mandar. */
function apiFalsa(respostas) {
  const chamadas = [];
  const fila = Array.isArray(respostas) ? [...respostas] : [respostas];
  return {
    chamadas,
    legado: [],
    salvarOrcamentoAutenticado: async (cmd) => {
      chamadas.push(cmd);
      return fila.length > 1 ? fila.shift() : fila[0];
    },
    montarPayloadOrcamentoRemoto: (p) => p,
    sincronizarOrcamento: async function (p) { this.legado.push(['criar', p]); return { id: 'remoto-gerado-pelo-servidor' }; },
    atualizarOrcamento: async function (rid, d) { this.legado.push(['editar', rid, d]); return { ok: true }; },
    atualizarStatusOrcamento: async function (rid, s) { this.legado.push(['status', rid, s]); return { ok: true }; },
  };
}

function terminalFalso() {
  const fallbacks = [];
  return { fallbacks, registrarFallback: async (op, chave, motivo) => { fallbacks.push({ op, chave, motivo }); } };
}

const mudo = { log() {}, warn() {}, error() {} };
const OK = (over = {}) => ({ tipo: 'ok', dados: { orcamento_id: 'loc-1', numero: 59, revisao: 1, ...over } });

describe('1-2. caminho imediato com rede', () => {
  test('criação: uma chamada, revisão confirmada, fila encerrada', async () => {
    const db = bancoFalso(); const api = apiFalsa(OK()); const term = terminalFalso();
    const r = await criarComandoOrcamento({ db, api, terminal: term, log: mudo }).executar('loc-1', 'salvar');

    assert.equal(r.tipo, 'ok');
    assert.equal(api.chamadas.length, 1);
    assert.equal(db._orc.revisao_base, 1, 'revisão só avança com confirmação');
    assert.equal(db._orc.op_chave, null, 'chave encerrada');
    assert.equal(db._fila[0].processado, 1, 'fila encerrada — sem revisão fantasma');
    assert.equal(term.fallbacks.length, 0);
  });

  test('edição: mesma identidade local, revisão sobe', async () => {
    const db = bancoFalso({ remote_id: 'loc-1', revisao_base: 1 });
    const api = apiFalsa(OK({ revisao: 2 }));
    const r = await criarComandoOrcamento({ db, api, terminal: terminalFalso(), log: mudo }).executar('loc-1', 'salvar');

    assert.equal(r.tipo, 'ok');
    assert.equal(api.chamadas[0].revisao_base, 1, 'manda a revisão confirmada, não um contador local');
    assert.equal(api.chamadas[0].idempotency_key, 'loc-1:r1:salvar');
    assert.equal(db._orc.id, 'loc-1', 'o id local NUNCA é reescrito');
    assert.equal(db._orc.revisao_base, 2);
  });
});

describe('3-4. imediata + retry = exatamente um efeito', () => {
  test('imediata falha, fila reexecuta com a MESMA chave', async () => {
    const db = bancoFalso();
    const api = apiFalsa([{ tipo: 'erro', motivo: 'rede', erro: 'timeout' }, OK()]);
    const cmd = criarComandoOrcamento({ db, api, terminal: terminalFalso(), log: mudo });

    const r1 = await cmd.executar('loc-1', 'salvar');
    assert.equal(r1.tipo, 'erro');
    assert.equal(db._orc.op_chave, 'loc-1:r0:salvar', 'a chave sobrevive à falha');
    assert.equal(db._fila[0].processado, 0, 'item continua na fila');

    const r2 = await cmd.executar('loc-1', 'salvar');   // o retry da fila
    assert.equal(r2.tipo, 'ok');
    assert.equal(api.chamadas[0].idempotency_key, api.chamadas[1].idempotency_key,
      'MESMA chave nas duas tentativas — é isto que garante um efeito só');
    assert.equal(db._fila[0].processado, 1);
  });

  test('servidor GRAVA e a resposta se perde: retry manda a mesma chave', async () => {
    // O caso difícil. O cliente não sabe que gravou; se a chave mudasse aqui,
    // o servidor criaria um segundo documento com número novo.
    const db = bancoFalso();
    const api = apiFalsa([{ tipo: 'erro', motivo: 'rede', erro: 'socket hang up' },
                          OK({ repetido: true })]);
    const cmd = criarComandoOrcamento({ db, api, terminal: terminalFalso(), log: mudo });

    await cmd.executar('loc-1', 'salvar');
    assert.equal(db._orc.revisao_base, 0, 'revisão NÃO avança só porque enviou');

    await cmd.executar('loc-1', 'salvar');
    assert.equal(api.chamadas[1].idempotency_key, 'loc-1:r0:salvar');
    assert.equal(api.chamadas[1].revisao_base, 0, 'ainda parte da revisão confirmada, que era 0');
    assert.equal(db._orc.revisao_base, 1, 'só confirma depois do replay');
  });
});

describe('5. sucesso imediato limpa a fila', () => {
  test('sem isso a fila criaria uma revisão fantasma', async () => {
    const db = bancoFalso(); const api = apiFalsa(OK());
    await criarComandoOrcamento({ db, api, terminal: terminalFalso(), log: mudo }).executar('loc-1', 'salvar');
    assert.equal(db._fila[0].processado, 1);
  });
});

describe('6. rota desligada → fallback EXPLÍCITO', () => {
  test('cai no legado e registra, nunca em silêncio', async () => {
    const db = bancoFalso(); const api = apiFalsa({ tipo: 'legado', motivo: 'rota_desligada' });
    const term = terminalFalso();
    const r = await criarComandoOrcamento({ db, api, terminal: term, log: mudo }).executar('loc-1', 'salvar');

    assert.equal(r.tipo, 'legado');
    assert.equal(term.fallbacks.length, 1, 'foi contado');
    assert.equal(term.fallbacks[0].op, 'orcamentos.salvar');
    assert.equal(term.fallbacks[0].motivo, 'rota_desligada');
    assert.ok(term.fallbacks[0].chave, 'com a chave, para dar para cruzar depois');
    assert.equal(api.legado[0][0], 'criar', 'e só então o caminho antigo');
  });

  test('o fallback é registrado ANTES de gravar pelo legado', async () => {
    // Se fosse depois, uma falha do legado apagaria o registro de que
    // tentamos — e o número que autoriza o corte do `anon` mentiria.
    const ordem = [];
    const db = bancoFalso();
    const api = apiFalsa({ tipo: 'legado', motivo: 'rota_desligada' });
    api.sincronizarOrcamento = async () => { ordem.push('legado'); return { id: 'r1' }; };
    const term = { registrarFallback: async () => { ordem.push('fallback'); } };
    await criarComandoOrcamento({ db, api, terminal: term, log: mudo }).executar('loc-1', 'salvar');
    assert.deepEqual(ordem, ['fallback', 'legado']);
  });
});

describe('7. cancelamento tem chave própria', () => {
  test('cancelar usa :cancelar, não se confunde com salvar', async () => {
    const db = bancoFalso({ remote_id: 'loc-1', revisao_base: 1, status: 'cancelado' });
    const api = apiFalsa(OK({ revisao: 2 }));
    await criarComandoOrcamento({ db, api, terminal: terminalFalso(), log: mudo }).executar('loc-1', 'cancelar');
    assert.equal(api.chamadas[0].idempotency_key, 'loc-1:r1:cancelar');
    assert.equal(api.chamadas[0].acao, 'cancelar');
  });

  test('cancelar + resposta perdida + retry = um cancelamento', async () => {
    const db = bancoFalso({ remote_id: 'loc-1', revisao_base: 1 });
    const api = apiFalsa([{ tipo: 'erro', motivo: 'rede', erro: 'timeout' }, OK({ revisao: 2, repetido: true })]);
    const cmd = criarComandoOrcamento({ db, api, terminal: terminalFalso(), log: mudo });
    await cmd.executar('loc-1', 'cancelar');
    await cmd.executar('loc-1', 'cancelar');
    assert.equal(api.chamadas[0].idempotency_key, api.chamadas[1].idempotency_key);
    assert.equal(db._orc.revisao_base, 2, 'uma revisão, não duas');
  });
});

describe('8. orçamento nascido no legado', () => {
  test('USA remote_id, e não cria um segundo documento', async () => {
    // Os 55 orçamentos anteriores têm remote_id gerado pelo servidor, que é
    // diferente do id local. Mandar o id local faria a RPC não achar linha,
    // tratar como criação, e queimar um número novo.
    const db = bancoFalso({ remote_id: 'uuid-do-servidor-antigo', revisao_base: 0 });
    const api = apiFalsa(OK({ orcamento_id: 'uuid-do-servidor-antigo', numero: 12, revisao: 1 }));
    await criarComandoOrcamento({ db, api, terminal: terminalFalso(), log: mudo }).executar('loc-1', 'salvar');

    assert.equal(api.chamadas[0].orcamento_id, 'uuid-do-servidor-antigo',
      'localiza o documento existente');
    assert.equal(api.chamadas[0].idempotency_key, 'uuid-do-servidor-antigo:r0:salvar');
    assert.equal(db._orc.id, 'loc-1', 'a identidade local segue separada e intacta');
  });

  test('cancelar um orçamento legado também usa remote_id', async () => {
    const db = bancoFalso({ remote_id: 'uuid-antigo' });
    const api = apiFalsa(OK({ orcamento_id: 'uuid-antigo', revisao: 1 }));
    await criarComandoOrcamento({ db, api, terminal: terminalFalso(), log: mudo }).executar('loc-1', 'cancelar');
    assert.equal(api.chamadas[0].orcamento_id, 'uuid-antigo');
  });
});

describe('9. reinício do Electron com item pendente', () => {
  test('a chave vem do disco, não é remontada', async () => {
    // Simula o processo morto e reaberto: o estado local traz op_chave
    // gravada de antes. Mesmo que a revisão local tivesse mudado, a chave
    // persistida vence — é o que impede um segundo documento.
    const db = bancoFalso({ op_chave: 'loc-1:r0:salvar', revisao_base: 0 });
    const api = apiFalsa(OK({ repetido: true }));
    await criarComandoOrcamento({ db, api, terminal: terminalFalso(), log: mudo }).executar('loc-1', 'salvar');
    assert.equal(api.chamadas[0].idempotency_key, 'loc-1:r0:salvar');
  });
});

describe('10. replay não consome número novo', () => {
  test('o número volta igual no replay', async () => {
    const db = bancoFalso();
    const api = apiFalsa([OK({ numero: 59 }), OK({ numero: 59, repetido: true })]);
    const cmd = criarComandoOrcamento({ db, api, terminal: terminalFalso(), log: mudo });
    const a = await cmd.executar('loc-1', 'salvar');
    db._orc.op_chave = 'loc-1:r0:salvar';           // como se não tivesse confirmado
    db._orc.revisao_base = 0;
    const b = await cmd.executar('loc-1', 'salvar');
    assert.equal(a.dados.numero, b.dados.numero, 'mesmo documento, mesmo número');
  });
});

describe('11-12. conflito e estado parcial', () => {
  test('conflito não repete, não cai no legado, não some', async () => {
    const db = bancoFalso({ remote_id: 'loc-1', revisao_base: 1 });
    const api = apiFalsa({ tipo: 'conflito', erro: 'conflito_versao' });
    const term = terminalFalso();
    const r = await criarComandoOrcamento({ db, api, terminal: term, log: mudo }).executar('loc-1', 'salvar');

    assert.equal(r.tipo, 'conflito');
    assert.equal(db._orc.sync_status, 'conflito', 'fica visível');
    assert.equal(api.legado.length, 0, 'NÃO caiu no legado — sobrescreveria a edição do outro');
    assert.equal(term.fallbacks.length, 0);
    assert.equal(db._fila[0].processado, 1, 'e não vira retry infinito');
  });

  test('cabeçalho e itens vão na MESMA chamada', async () => {
    // A atomicidade é da RPC, mas ela só é possível porque o cliente manda os
    // dois juntos. Duas chamadas separadas foi o defeito original.
    const db = bancoFalso(); const api = apiFalsa(OK());
    await criarComandoOrcamento({ db, api, terminal: terminalFalso(), log: mudo }).executar('loc-1', 'salvar');
    assert.equal(api.chamadas.length, 1);
    assert.ok(api.chamadas[0].orc, 'cabeçalho');
    assert.equal(api.chamadas[0].itens.length, 1, 'itens, na mesma chamada');
  });
});

describe('PROVA POR CONTRADIÇÃO — falharia na implementação anterior', () => {
  test('o caminho imediato ATRAVESSA a camada autenticada', async () => {
    // Na implementação anterior, `orcamentos:registrar` chamava
    // `api.sincronizarOrcamento` direto e a rota autenticada nunca era
    // tocada. Este teste exige o contrário: com a rota disponível, o legado
    // NÃO pode ser chamado.
    const db = bancoFalso(); const api = apiFalsa(OK());
    await criarComandoOrcamento({ db, api, terminal: terminalFalso(), log: mudo }).executar('loc-1', 'salvar');

    assert.equal(api.chamadas.length, 1, 'passou pela rota autenticada');
    assert.deepEqual(api.legado, [], 'e NÃO chamou nenhuma função legada');
  });

  test('nenhum desfecho deixa a operação sem rastro', async () => {
    // O orçamento 59 passou pelo legado sem nada em pdv_operacoes. Agora todo
    // caminho ou usa a rota autenticada, ou registra fallback, ou permanece
    // na fila com a chave viva. Silêncio não é mais um desfecho possível.
    for (const [resposta, esperado] of [
      [OK(), 'ok'],
      [{ tipo: 'legado', motivo: 'rota_desligada' }, 'legado'],
      [{ tipo: 'conflito', erro: 'x' }, 'conflito'],
      [{ tipo: 'erro', motivo: 'rede', erro: 'x' }, 'erro'],
    ]) {
      const db = bancoFalso(); const term = terminalFalso();
      const r = await criarComandoOrcamento({ db, api: apiFalsa(resposta), terminal: term, log: mudo })
        .executar('loc-1', 'salvar');
      assert.equal(r.tipo, esperado);
      const rastro = r.tipo === 'ok' || term.fallbacks.length > 0
        || db._orc.sync_status === 'conflito' || db._orc.op_chave !== null;
      assert.ok(rastro, `desfecho "${esperado}" ficou sem rastro`);
    }
  });
});

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// RECEBER CARTEIRA PELO MESMO CAMINHO DO SISTEMA (receber_contas_em_lote_v1).
//
// O que decide dinheiro aqui: (1) a repartição do valor entre as contas,
// (2) o lote que vai para o banco e (3) a nova tentativa depois de uma
// falha de conexão, que não pode aplicar o mesmo dinheiro duas vezes.

const supabaseClientPath = require.resolve('../src/main/supabaseClient');
const apiPath = require.resolve('../src/main/api');

function instalar({ contas = [], recebimentos = [], rpc = null, falhaRede = false }) {
  const chamadas = { rpc: [] };
  const fake = {
    from(tabela) {
      const filtros = [];
      const cadeia = {
        select() { return cadeia; },
        eq(c, v) { filtros.push(l => l[c] === v); return cadeia; },
        in(c, vs) { filtros.push(l => vs.includes(l[c])); return cadeia; },
        order() { return cadeia; },
        then(resolve) {
          if (falhaRede) return resolve({ data: null, error: { message: 'TypeError: fetch failed' } });
          const base = tabela === 'contas_receber' ? contas : tabela === 'recebimentos' ? recebimentos : [];
          return resolve({ data: base.filter(l => filtros.every(f => f(l))), error: null });
        },
      };
      return cadeia;
    },
    async rpc(nome, args) {
      chamadas.rpc.push({ nome, args });
      if (rpc) return rpc(nome, args);
      return { data: { estado: 'aplicado', aplicados: args.p_payload.contas.length }, error: null };
    },
  };
  require.cache[supabaseClientPath] = { id: supabaseClientPath, filename: supabaseClientPath, loaded: true, exports: fake };
  delete require.cache[apiPath];
  return { api: require('../src/main/api'), chamadas };
}

const conta = (id, original, recebido, doc = id) => ({
  id, numero_doc: doc, valor_original: original, valor_recebido: recebido,
  cliente_id: 'cli1', status: recebido > 0 ? 'parcial' : 'aberto',
});

describe('repartição do valor entre as contas', () => {
  const { api } = instalar({});

  test('quita da mais antiga para a mais nova e a última fica parcial', () => {
    const r = api._repartirRecebimento([conta('a', 50, 0), conta('b', 30, 10), conta('c', 40, 0)], 75);
    assert.deepEqual(r.itens.map(i => [i.contaId, i.valor, i.quitou, i.restanteConta]), [
      ['a', 50, true, 0], ['b', 20, true, 0], ['c', 5, false, 35],
    ]);
    assert.equal(r.sobra, 0);
  });

  test('conta com parcial anterior recebe só o que falta nela', () => {
    const r = api._repartirRecebimento([conta('x', 154.51, 131.5)], 23.01);
    assert.equal(r.itens[0].valor, 23.01);
    assert.equal(r.itens[0].quitou, true);
  });

  test('valor acima do total em aberto vira sobra, não é aplicado', () => {
    const r = api._repartirRecebimento([conta('a', 10, 0)], 15);
    assert.equal(r.itens[0].valor, 10);
    assert.equal(r.sobra, 5);
  });
});

describe('receberCarteira', () => {
  test('manda um lote só para o banco, com operador e data, e devolve o resumo', async () => {
    const { api, chamadas } = instalar({ contas: [conta('a', 50, 0, 'CART-A'), conta('b', 30, 0, 'CART-B')] });
    const r = await api.receberCarteira({ clienteId: 'cli1', valor: 60, forma: 'pix', observacao: null, loteId: 'L1' });

    assert.equal(chamadas.rpc.length, 1);
    assert.equal(chamadas.rpc[0].nome, 'receber_contas_em_lote_v1');
    const p = chamadas.rpc[0].args.p_payload;
    assert.equal(p.lote_id, 'L1');
    assert.deepEqual(p.contas.map(c => [c.conta_id, c.valor, c.forma_pagamento]), [['a', 50, 'pix'], ['b', 10, 'pix']]);
    assert.match(p.contas[0].data_recebimento, /^\d{4}-\d{2}-\d{2}$/);

    assert.equal(r.ok, true);
    assert.equal(r.total, 60);
    assert.equal(r.abertoAntes, 80);
    assert.equal(r.abertoDepois, 20);
    assert.deepEqual(r.itens.map(i => i.doc), ['CART-A', 'CART-B']);
  });

  test('conta individual: só a conta escolhida entra no lote', async () => {
    const { api, chamadas } = instalar({ contas: [conta('a', 50, 0), conta('b', 30, 0)] });
    await api.receberCarteira({ clienteId: 'cli1', valor: 30, contaIds: ['b'], forma: 'dinheiro', loteId: 'L2' });
    assert.deepEqual(chamadas.rpc[0].args.p_payload.contas.map(c => c.conta_id), ['b']);
  });

  test('recusa do banco volta como recusa, sem fingir que entrou', async () => {
    const { api } = instalar({
      contas: [conta('a', 50, 0)],
      rpc: () => ({ data: { estado: 'conta_indisponivel', motivo: 'a conta ja foi quitada' }, error: null }),
    });
    const r = await api.receberCarteira({ clienteId: 'cli1', valor: 50, forma: 'dinheiro', loteId: 'L3' });
    assert.equal(r.ok, false);
    assert.equal(r.recusa.estado, 'conta_indisponivel');
  });

  test('sem internet lança erro (quem chama avisa que nada foi registrado)', async () => {
    const { api } = instalar({ falhaRede: true });
    await assert.rejects(() => api.receberCarteira({ clienteId: 'cli1', valor: 10, forma: 'dinheiro', loteId: 'L4' }));
  });

  test('nova tentativa de um lote que já entrou NÃO grava de novo', async () => {
    // A primeira chamada gravou e a resposta se perdeu: a conta "a" já está
    // paga e só a "c" segue aberta. Repartir de novo aplicaria o dinheiro
    // na "c".
    const { api, chamadas } = instalar({
      contas: [conta('c', 40, 0)],
      recebimentos: [{ lote_id: 'L5', conta_id: 'a', valor: 50, valor_liquido: 50 }],
    });
    const r = await api.receberCarteira({ clienteId: 'cli1', valor: 50, forma: 'dinheiro', loteId: 'L5' });
    assert.equal(chamadas.rpc.length, 0, 'não chamou o banco de novo');
    assert.equal(r.ok, true);
    assert.equal(r.jaRegistrado, true);
    assert.equal(r.total, 50);
    assert.equal(r.abertoDepois, 40);
  });
});

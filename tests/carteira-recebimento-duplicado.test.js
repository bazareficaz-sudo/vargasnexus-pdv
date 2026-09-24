const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Reproduz o bug medido em produção (extrato de DANIEL BORRACHA e outros 2
// clientes, 15 contas, R$ 825,82): `pagarContaReceber`/`pagarContaReceberParcial`
// nunca checavam se a conta já estava `status='recebido'` no servidor antes
// de gravar. A lista local do caixa (Carteira de Clientes) só atualiza no
// sync — uma conta já quitada pelo site (ou por outro terminal) continuava
// aparecendo como pendente até o próximo sync, e um segundo clique em
// "Receber" gravava um SEGUNDO `recebimentos` para o mesmo valor, sem nada
// em `contas_receber` acusar o problema. Isso inflava o "pago" no extrato
// do site (que soma `recebimentos`), fazendo o saldo devedor parecer menor
// do que realmente era.
//
// Troca `./supabaseClient` (um cliente real, instanciado no topo do módulo)
// por um duplo controlável ANTES de `api.js` ser exigido — só assim os
// `supabase.from(...)` dentro de api.js enxergam o estado de teste.

const supabaseClientPath = require.resolve('../src/main/supabaseClient');
const apiPath = require.resolve('../src/main/api');

function instalarSupabaseFalso(estadoInicial) {
  const estado = JSON.parse(JSON.stringify(estadoInicial));
  const chamadas = { updates: [], inserts: [] };

  function buscarSingle(nomeTabela, filtros) {
    const linha = (estado[nomeTabela] || []).find(l =>
      Object.entries(filtros).every(([k, v]) => l[k] === v));
    return { data: linha ? { ...linha } : null, error: linha ? null : { message: 'não encontrado' } };
  }

  const fake = {
    from(nomeTabela) {
      return {
        select() {
          return {
            eq(campo, valor) {
              return { single: async () => buscarSingle(nomeTabela, { [campo]: valor }) };
            },
          };
        },
        update(dados) {
          return {
            eq: async (campo, valor) => {
              const linha = (estado[nomeTabela] || []).find(l => l[campo] === valor);
              if (linha) Object.assign(linha, dados);
              chamadas.updates.push({ tabela: nomeTabela, dados, filtro: { [campo]: valor } });
              return { error: null };
            },
          };
        },
        insert: async (dados) => {
          estado[nomeTabela] = estado[nomeTabela] || [];
          estado[nomeTabela].push({ id: `gerado-${estado[nomeTabela].length}`, ...dados });
          chamadas.inserts.push({ tabela: nomeTabela, dados });
          return { error: null };
        },
      };
    },
  };

  require.cache[supabaseClientPath] = { id: supabaseClientPath, filename: supabaseClientPath, loaded: true, exports: fake };
  delete require.cache[apiPath];
  const api = require('../src/main/api');
  return { api, estado, chamadas };
}

describe('pagarContaReceber — trava contra recebimento em duplicidade', () => {
  test('conta ainda aberta: recebe normalmente, um insert em recebimentos', async () => {
    const { api, estado, chamadas } = instalarSupabaseFalso({
      contas_receber: [{ id: 'c1', valor_original: 100, valor_recebido: 0, status: 'aberto', empresa_id: 'e1', cliente_id: 'cli1' }],
      recebimentos: [],
    });

    const r = await api.pagarContaReceber('c1', 'dinheiro', null);

    assert.equal(r.ok, true);
    assert.ok(!r.jaEstavaPago);
    assert.equal(chamadas.inserts.length, 1, 'gravou um recebimento');
    assert.equal(estado.contas_receber[0].status, 'recebido');
  });

  test('conta já recebida (por outro terminal ou pelo site): não duplica o recebimento', async () => {
    const { api, chamadas } = instalarSupabaseFalso({
      contas_receber: [{ id: 'c1', valor_original: 100, valor_recebido: 100, status: 'recebido', empresa_id: 'e1', cliente_id: 'cli1' }],
      recebimentos: [{ id: 'r0', conta_id: 'c1', valor: 100 }],
    });

    const r = await api.pagarContaReceber('c1', 'debito', null);

    assert.equal(r.ok, true);
    assert.equal(r.jaEstavaPago, true, 'avisa que já estava paga, não trata como sucesso silencioso');
    assert.equal(chamadas.inserts.length, 0, 'NÃO grava um segundo recebimento — é o bug do Daniel Borracha');
    assert.equal(chamadas.updates.length, 0, 'não reescreve a conta que já estava certa');
  });
});

describe('pagarContaReceberParcial — mesma trava', () => {
  test('conta já recebida: não aplica outro pagamento parcial por cima', async () => {
    const { api, chamadas } = instalarSupabaseFalso({
      contas_receber: [{ id: 'c2', valor_original: 50, valor_recebido: 50, status: 'recebido', empresa_id: 'e1', cliente_id: 'cli1' }],
      recebimentos: [],
    });

    const r = await api.pagarContaReceberParcial('c2', 10, 50, 'pix', null);

    assert.equal(r.ok, true);
    assert.equal(r.jaEstavaPago, true);
    assert.equal(chamadas.inserts.length, 0);
    assert.equal(chamadas.updates.length, 0);
  });

  test('conta parcialmente paga: aceita novo pagamento parcial normalmente', async () => {
    const { api, estado, chamadas } = instalarSupabaseFalso({
      contas_receber: [{ id: 'c3', valor_original: 50, valor_recebido: 20, status: 'parcial', empresa_id: 'e1', cliente_id: 'cli1' }],
      recebimentos: [],
    });

    const r = await api.pagarContaReceberParcial('c3', 30, 50, 'pix', null);

    assert.equal(r.ok, true);
    assert.ok(!r.jaEstavaPago);
    assert.equal(chamadas.inserts.length, 1);
    assert.equal(estado.contas_receber[0].status, 'recebido');
    assert.equal(estado.contas_receber[0].valor_recebido, 50);
  });
});

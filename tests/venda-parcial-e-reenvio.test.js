const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// FASE 0.6D.0R — O DEFEITO CENTRAL, REPRODUZIDO.
//
// A 0.6C.6A deu identidade à venda: `montarInsert` manda `id: venda.id`, e um
// reenvio do mesmo UUID é reconhecido por `.eq('id', venda.id)` em vez de pela
// heurística `numero + total + janela`. A linha `vendas` ficou idempotente.
//
// Estes testes fazem a pergunta seguinte, que é a da 0.6D.2: o que acontece
// com os EFEITOS da venda — itens e estoque — quando a primeira tentativa
// grava `vendas` e não chega aos demais?
//
// AUDITORIA. Nada aqui corrige nada: o objetivo é deixar o comportamento
// atual demonstrado por teste executável, para a 0.6D.2 ser desenhada contra
// um fato, não contra uma suposição.
//
// Roda sob `npm test`: só mocks — sem banco, sem rede, sem Electron.

// Ids em formato UUID de propósito: `_comoUuid()` descarta qualquer coisa
// fora do formato, e um id inválido faria o item virar órfão (produto_id
// null) e o estoque nem ser tentado — mascarando justamente o que se quer ver.
const PRODUTO = '11111111-1111-4111-8111-111111111111';
const DEPOSITO = '44444444-4444-4444-8444-444444444444';
const VENDA_V = '22222222-2222-4222-8222-222222222222';
const VENDA_W = '33333333-3333-4333-8333-333333333333';

// ─── Servidor falso: só o suficiente para `registrarVenda` ────────────────
function criarServidorFalso() {
  const tabelas = {
    vendas: [], venda_itens: [], estoque_movimentacoes: [],
    produtos: [{ id: PRODUTO, estoque: 240 }],
    produto_estoque: [{ id: 'pe-1', produto_id: PRODUTO, deposito_id: DEPOSITO, quantidade: 240 }],
    depositos: [{ id: DEPOSITO, empresa_id: 'emp-1', principal: true }],
  };
  // Injetável: permite simular a queda da rede num ponto exato.
  const falhas = { vendasInsert: null, vendaItensInsert: null };

  function from(tabela) {
    const ctx = { tabela, filtros: [], payload: null, op: null };

    const executar = () => {
      const linhas = tabelas[ctx.tabela] || [];
      const casa = (l) => ctx.filtros.every(([c, v]) => l[c] === v);

      if (ctx.op === 'insert') {
        if (ctx.tabela === 'vendas' && falhas.vendasInsert) {
          const modo = falhas.vendasInsert;
          // "gravou e a resposta se perdeu": a linha entra, o cliente vê erro.
          if (modo === 'gravou_resposta_perdida') {
            for (const p of [].concat(ctx.payload)) linhas.push({ ...p });
            return { data: null, error: { message: 'network timeout', code: 'ETIMEDOUT' } };
          }
          if (modo === 'nao_gravou') return { data: null, error: { message: 'network down', code: 'ENETDOWN' } };
        }
        if (ctx.tabela === 'venda_itens' && falhas.vendaItensInsert) {
          return { data: null, error: { message: 'network down', code: 'ENETDOWN' } };
        }
        const novas = [].concat(ctx.payload);
        for (const p of novas) {
          // PK real: mesmo id duas vezes é violação, como no Postgres.
          if (p.id && linhas.some(l => l.id === p.id)) {
            return { data: null, error: { message: 'duplicate key value violates unique constraint "vendas_pkey"', code: '23505' } };
          }
          linhas.push({ ...p });
        }
        return { data: novas.length === 1 ? { ...novas[0] } : novas, error: null };
      }

      if (ctx.op === 'update') {
        const alvo = linhas.filter(casa);
        for (const l of alvo) Object.assign(l, ctx.payload);
        return { data: alvo.length ? { ...alvo[0] } : null, error: null };
      }

      const achadas = linhas.filter(casa);
      return { data: achadas.length ? { ...achadas[0] } : null, error: null };
    };

    const builder = {
      insert(p) { ctx.op = 'insert'; ctx.payload = p; return builder; },
      update(p) { ctx.op = 'update'; ctx.payload = p; return builder; },
      select() { return builder; },
      eq(c, v) { ctx.filtros.push([c, v]); return builder; },
      single() {
        const r = executar();
        return Promise.resolve(r.data ? r : { data: null, error: r.error || { message: 'no rows', code: 'PGRST116' } });
      },
      maybeSingle() { return Promise.resolve(executar()); },
      then(res, rej) { return Promise.resolve(executar()).then(res, rej); },
    };
    return builder;
  }

  return { tabelas, falhas, client: { from } };
}

// ─── Carrega api.js com electron-store e supabaseClient trocados ──────────
function carregarApi(servidor) {
  const original = Module._load;
  Module._load = function (pedido) {
    if (pedido === 'electron-store') {
      return class {
        get(chave) {
          if (chave === 'auth.usuario') return { nome: 'teste', empresa_id: 'emp-1', deposito_id: DEPOSITO };
          if (chave === 'config.terminal_id') return 'PDV-TESTE';
          return null;
        }
      };
    }
    if (pedido === './supabaseClient') return servidor.client;
    return original.apply(this, arguments);
  };
  try {
    const caminho = require.resolve('../src/main/api');
    delete require.cache[caminho];
    return require(caminho);
  } finally {
    Module._load = original;
  }
}

const vendaBase = (id, numero) => ({
  id, numero, total: 0.2, subtotal: 0.2, desconto: 0,
  forma_pagamento: 'dinheiro', valor_pago: 0.2, troco: 0,
  empresa_id: 'emp-1', deposito_id: DEPOSITO, cliente_remote_id: null,
  itens: [{ produto_remote_id: PRODUTO, produto_nome: 'BUCHA TRIFIX 8',
            quantidade: 1, preco_unitario: 0.2, desconto: 0, total: 0.2 }],
});

describe('0.6D.0R — identidade da venda × efeitos da venda', () => {
  test('primeiro envio: venda, item e estoque entram juntos', async () => {
    const s = criarServidorFalso();
    const api = carregarApi(s);

    const r = await api.registrarVenda(vendaBase(VENDA_V, 1000009));

    assert.equal(s.tabelas.vendas.length, 1);
    assert.equal(s.tabelas.venda_itens.length, 1);
    assert.equal(s.tabelas.produtos[0].estoque, 239, 'CAS baixou 240 -> 239');
    assert.equal(s.tabelas.estoque_movimentacoes.length, 1);
    assert.equal(r.id, VENDA_V);
  });

  test('a linha vendas É idempotente: reenvio do mesmo UUID não duplica', async () => {
    const s = criarServidorFalso();
    const api = carregarApi(s);

    await api.registrarVenda(vendaBase(VENDA_V, 1000009));
    await api.registrarVenda(vendaBase(VENDA_V, 1000009)); // reenvio integral

    assert.equal(s.tabelas.vendas.length, 1, 'uma linha vendas — a PK segurou e o id foi reconhecido');
  });

  test('ETAPA N — resposta perdida: reconhecida NA MESMA CHAMADA, e os efeitos não acontecem', async () => {
    const s = criarServidorFalso();
    const api = carregarApi(s);

    // O INSERT chega ao servidor; a resposta se perde.
    s.falhas.vendasInsert = 'gravou_resposta_perdida';
    const r = await api.registrarVenda(vendaBase(VENDA_V, 1000009));

    // Não lança: `if (error && venda.id)` encontra a linha e devolve sucesso.
    assert.equal(r.id, VENDA_V, 'devolveu a venda existente, como sucesso');
    assert.equal(s.tabelas.vendas.length, 1, 'a venda está no servidor');

    // O ACHADO: o `return existente` acontece ANTES do bloco de itens e do
    // laço de estoque. Nem agora, nem depois — não há caminho de volta.
    assert.equal(s.tabelas.venda_itens.length, 0, 'ITENS AUSENTES');
    assert.equal(s.tabelas.produtos[0].estoque, 240, 'ESTOQUE NUNCA BAIXOU');
    assert.equal(s.tabelas.estoque_movimentacoes.length, 0, 'sem movimentação');

    // E um reenvio posterior repete o mesmo reconhecimento — não completa.
    s.falhas.vendasInsert = null;
    await api.registrarVenda(vendaBase(VENDA_V, 1000009));
    assert.equal(s.tabelas.venda_itens.length, 0,
      'o reenvio reconhece de novo e retorna cedo: PARCIAL PERMANENTE');
    assert.equal(s.tabelas.produtos[0].estoque, 240);
  });

  test('ETAPA M — crash antes dos itens: mesmo desfecho, permanente', async () => {
    const s = criarServidorFalso();
    const api = carregarApi(s);

    // A venda entra; os itens não (aqui a rede cai; no mundo real o processo
    // morre). O estoque chega a baixar, porque vem depois no mesmo laço.
    s.falhas.vendaItensInsert = true;
    await api.registrarVenda(vendaBase(VENDA_V, 1000009));
    assert.equal(s.tabelas.vendas.length, 1);
    assert.equal(s.tabelas.venda_itens.length, 0);

    // Restart: a fila reenvia a mesma venda.
    s.falhas.vendaItensInsert = null;
    await api.registrarVenda(vendaBase(VENDA_V, 1000009));

    assert.equal(s.tabelas.venda_itens.length, 0,
      'o reenvio reconhece a venda e retorna cedo: ela fica sem itens PARA SEMPRE');
  });

  test('erro de venda_itens não derruba a venda — vira console.warn', async () => {
    const s = criarServidorFalso();
    const api = carregarApi(s);
    s.falhas.vendaItensInsert = true;

    const r = await api.registrarVenda(vendaBase(VENDA_V, 1000009));

    assert.equal(r.id, VENDA_V, 'a venda é dada como boa mesmo sem itens');
    assert.equal(s.tabelas.venda_itens.length, 0);
    assert.equal(s.tabelas.produtos[0].estoque, 239,
      'e o estoque baixou assim mesmo: venda sem itens, com saldo movido');
  });

  test('o estoque NÃO tem chave de idempotência: reaplicar baixa de novo', async () => {
    const s = criarServidorFalso();
    const api = carregarApi(s);

    await api.registrarVenda(vendaBase(VENDA_V, 1000009));
    assert.equal(s.tabelas.produtos[0].estoque, 239);

    // Outra venda, mesmos itens — é o que acontecia antes da 0.6C.6A, e é o
    // que ainda aconteceria se o id não viajasse.
    await api.registrarVenda(vendaBase(VENDA_W, 1000010));

    assert.equal(s.tabelas.produtos[0].estoque, 238, 'baixou duas vezes');
    assert.equal(s.tabelas.estoque_movimentacoes.length, 2,
      'duas movimentações — nada no caminho pergunta se aquele item já baixou');
  });
});

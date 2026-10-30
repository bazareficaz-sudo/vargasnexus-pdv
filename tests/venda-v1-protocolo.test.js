const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { montarPayloadVendaV1 } = require('../src/main/payloadVendaV1');
const { escolherProtocolo, interpretarResposta } = require('../src/main/protocoloVenda');

// FASE 0.6D.3 — o protocolo v1 do lado do terminal.
//
// Três propriedades sustentam tudo, e cada uma tem seus testes aqui:
//
//   1. o payload é determinístico — mesmo estado local, mesmo payload;
//   2. o protocolo escolhido PERSISTE — flag desligada não converte retry;
//   3. NÃO EXISTE dual-write — v1 nunca chama o caminho legado.

const PRODUTO = '11111111-1111-4111-8111-111111111111';
const VENDA = '22222222-2222-4222-8222-222222222222';
const ITEM1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const ITEM2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const EMPRESA = '33333333-3333-4333-8333-333333333333';
const DEPOSITO = '44444444-4444-4444-8444-444444444444';

const vendaLocal = (over = {}) => ({
  id: VENDA, numero: 1000010, subtotal: 30, desconto: 0, total: 30,
  forma_pagamento: 'dinheiro', valor_pago: 30, troco: 0, status: 'concluida',
  empresa_id: EMPRESA, deposito_id: DEPOSITO, created_at: '2026-09-15T12:00:00.000Z',
  cliente_remote_id: null, cliente_nome: null, orcamento_remote_id: null,
  itens: [{ id: ITEM1, produto_remote_id: PRODUTO, produto_nome: 'PROD', produto_sku: 'SKU1',
            quantidade: 3, preco_unitario: 10, desconto: 0, total: 30 }],
  ...over,
});

const ctx = { empresaId: EMPRESA, depositoId: DEPOSITO, terminalId: 'PDV-010', operadorNome: 'teste' };

describe('payload v1 — determinístico', () => {
  test('mesmo estado local produz payload idêntico (duas montagens)', () => {
    const a = montarPayloadVendaV1(vendaLocal(), ctx);
    const b = montarPayloadVendaV1(vendaLocal(), ctx);
    assert.equal(a.ok && b.ok, true);
    assert.deepEqual(a.payload, b.payload);
  });

  test('O ID DO ITEM VEM DO SQLITE — nunca é gerado aqui', () => {
    // Se fosse gerado na montagem, cada retry mudaria o fingerprint e o
    // servidor trataria reenvio legítimo como conflito_payload.
    const p = montarPayloadVendaV1(vendaLocal(), ctx).payload;
    assert.equal(p.itens[0].id, ITEM1);
  });

  test('item sem id em formato uuid é recusado antes de sair do terminal', () => {
    const r = montarPayloadVendaV1(vendaLocal({
      itens: [{ produto_remote_id: PRODUTO, produto_nome: 'SEM ID', quantidade: 1, total: 1 }],
    }), ctx);
    assert.equal(r.ok, false);
    assert.match(r.erro, /item sem id/);
  });

  test('schema_version é 1', () => {
    assert.equal(montarPayloadVendaV1(vendaLocal(), ctx).payload.schema_version, 1);
  });

  test('produto sem remote_id vira null, nunca o id local', () => {
    // Mandar o id local como se fosse remoto cria item órfão no Supabase.
    const p = montarPayloadVendaV1(vendaLocal({
      itens: [{ id: ITEM1, produto_id: 'local-123', produto_remote_id: null,
                produto_nome: 'OFFLINE', quantidade: 1, preco_unitario: 5, total: 5 }],
    }), ctx).payload;
    assert.equal(p.itens[0].produto_id, null);
  });

  test('mesmo produto em duas linhas: dois itens, ids distintos', () => {
    const p = montarPayloadVendaV1(vendaLocal({
      itens: [
        { id: ITEM1, produto_remote_id: PRODUTO, quantidade: 1, preco_unitario: 10, total: 10 },
        { id: ITEM2, produto_remote_id: PRODUTO, quantidade: 2, preco_unitario: 9, total: 18 },
      ],
    }), ctx).payload;
    assert.equal(p.itens.length, 2);
    assert.notEqual(p.itens[0].id, p.itens[1].id);
  });

  test('orçamento: vai o id REMOTO; sem remote_id vai null', () => {
    const comOrc = montarPayloadVendaV1(vendaLocal({ orcamento_remote_id: DEPOSITO }), ctx).payload;
    assert.equal(comOrc.orcamento_id, DEPOSITO);
    const semOrc = montarPayloadVendaV1(vendaLocal({ orcamento_id: 'local-999', orcamento_remote_id: null }), ctx).payload;
    assert.equal(semOrc.orcamento_id, null);
  });

  test('quantidade decimal preservada', () => {
    const p = montarPayloadVendaV1(vendaLocal({
      itens: [{ id: ITEM1, produto_remote_id: PRODUTO, quantidade: 1.5, preco_unitario: 10, total: 15 }],
    }), ctx).payload;
    assert.equal(p.itens[0].quantidade, 1.5);
  });

  test('carteira e cliente viajam quando existem', () => {
    const p = montarPayloadVendaV1(vendaLocal({
      forma_pagamento: 'carteira', cliente_remote_id: PRODUTO, cliente_nome: 'FULANO',
    }), ctx).payload;
    assert.equal(p.forma_pagamento, 'carteira');
    assert.equal(p.cliente_id, PRODUTO);
  });

  test('vazio vira null, não string vazia', () => {
    const p = montarPayloadVendaV1(vendaLocal({ observacao: '   ', vendedor_nome: '' }), ctx).payload;
    assert.equal(p.observacao, null);
    assert.equal(p.vendedor_nome, null);
  });
});

describe('escolha de protocolo — servidor decide venda nova', () => {
  test('flag local ligada não decide venda nova', () => {
    assert.equal(escolherProtocolo({ sync_protocolo: null }, true), 'negociando_v1');
  });

  test('flag local desligada não desvia venda nova para legado', () => {
    assert.equal(escolherProtocolo({ sync_protocolo: null }, false), 'negociando_v1');
  });

  test('FLAG DESLIGADA NÃO CONVERTE RETRY V1 EM LEGADO', () => {
    // O cenário da Etapa 12: venda começou v1, terminal fechou, alguém
    // desligou a flag, terminal reabriu. Se voltasse ao legado, mandaria
    // venda+itens+estoque de novo por um caminho que não conhece
    // `pdv_venda_sync` — duplicata garantida.
    assert.equal(escolherProtocolo({ sync_protocolo: 'v1' }, false), 'v1');
  });

  test('flag ligada não converte venda legado em v1', () => {
    assert.equal(escolherProtocolo({ sync_protocolo: 'legado' }, true), 'legado');
  });
});

describe('interpretação da resposta — nunca synced no escuro', () => {
  for (const estado of ['aplicada', 'ja_aplicada', 'completada_de_legado']) {
    test(`${estado} → synced`, () => {
      assert.equal(interpretarResposta({ estado }).desfecho, 'synced');
    });
  }

  test('completada_de_legado tem telemetria própria', () => {
    // É a medida de quantas vendas estavam parciais no servidor.
    assert.equal(interpretarResposta({ estado: 'completada_de_legado' }).telemetria,
      'venda_sync_v1_completada_legado');
  });

  for (const estado of ['conflito_payload', 'conflito_orcamento', 'legado_incompativel', 'payload_invalido']) {
    test(`${estado} → conflito terminal`, () => {
      assert.equal(interpretarResposta({ estado }).desfecho, 'conflito');
    });
  }

  test('TIMEOUT/REDE → pendente, nunca synced e nunca conflito', () => {
    // Estado remoto desconhecido: a venda pode estar gravada. Só o retry
    // com o mesmo UUID desempata.
    assert.equal(interpretarResposta({ ok: false, motivo: 'rede', erro: 'ETIMEDOUT' }).desfecho, 'pendente');
  });

  test('resposta vazia → pendente', () => {
    assert.equal(interpretarResposta({}).desfecho, 'pendente');
    assert.equal(interpretarResposta(null).desfecho, 'pendente');
  });

  test('estado desconhecido → pendente, não sucesso', () => {
    assert.equal(interpretarResposta({ estado: 'algo_que_nao_existe' }).desfecho, 'pendente');
  });

  test('rota desligada no servidor → pendente (jamais cai no legado)', () => {
    assert.equal(interpretarResposta({ ok: false, motivo: 'rota_desligada' }).desfecho, 'pendente');
  });
});

// ─── O CRITÉRIO DE GO ────────────────────────────────────────────────────
describe('SEM DUAL-WRITE — o caminho v1 não encosta no legado', () => {
  const SYNC = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'sync.js'), 'utf8');

  function corpoDaFuncao(nome) {
    const i = SYNC.indexOf(`async function ${nome}(`);
    assert.notEqual(i, -1, `${nome} sumiu de sync.js`);
    // Até a próxima declaração de função no topo do arquivo.
    const j = SYNC.indexOf('\nasync function ', i + 10);
    return SYNC.slice(i, j === -1 ? undefined : j);
  }

  test('_sincronizarVendaV1 NÃO chama api.registrarVenda', () => {
    assert.equal(/api\.registrarVenda/.test(corpoDaFuncao('_sincronizarVendaV1')), false,
      'o caminho v1 não pode chamar o registro legado da venda');
  });

  test('_sincronizarVendaV1 NÃO insere venda_itens', () => {
    assert.equal(/venda_itens/.test(corpoDaFuncao('_sincronizarVendaV1')), false);
  });

  test('_sincronizarVendaV1 NÃO mexe em estoque', () => {
    const corpo = corpoDaFuncao('_sincronizarVendaV1');
    assert.equal(/_ajustarEstoqueCAS|ajustarEstoqueRemoto|estoqueReparo|falhasEstoque/.test(corpo), false,
      'estoque no v1 é responsabilidade exclusiva da RPC');
  });

  test('_sincronizarVendaV1 chama a rota protegida, uma vez', () => {
    const corpo = corpoDaFuncao('_sincronizarVendaV1');
    const chamadas = [...corpo.matchAll(/chamarProtegida\(/g)];
    assert.equal(chamadas.length, 1);
    assert.match(corpo, /\/api\/pdv\/vendas\/sincronizar-v1/);
  });

  test('recusa pre-write só é avaliada na primeira tentativa da execução', () => {
    const corpo = corpoDaFuncao('_sincronizarVendaV1');
    assert.match(corpo, /podeNegociar && protocoloVenda.recusaPreWrite/);
    assert.match(corpo, /alterada.changes !== 1/);
  });

  test('a bifurcação acontece ANTES de qualquer efeito remoto da venda', () => {
    const corpo = corpoDaFuncao('_sincronizarVendaCreateExclusiva');
    const posBifurcacao = corpo.indexOf('_sincronizarVendaV1(venda)');
    const posLegado = corpo.indexOf('api.registrarVenda');
    assert.ok(posBifurcacao !== -1 && posLegado !== -1);
    assert.ok(posBifurcacao < posLegado, 'o v1 tem de retornar antes de o legado começar');
  });

  test('o portão de arbitragem continua ANTES da bifurcação', () => {
    const corpo = corpoDaFuncao('_sincronizarVendaCreateExclusiva');
    assert.ok(corpo.indexOf('_arbitrarAntesDeSubir') < corpo.indexOf('escolherProtocolo'),
      'nenhum efeito remoto — incluindo a escolha de protocolo — antes da arbitragem');
  });

  test('o protocolo é persistido antes de sair da máquina', () => {
    const corpo = corpoDaFuncao('_sincronizarVendaCreateExclusiva');
    assert.match(corpo, /UPDATE vendas SET sync_protocolo/);
    assert.ok(corpo.indexOf("sync_protocolo = 'negociando_v1'") < corpo.indexOf('_sincronizarVendaV1(venda, true)'));
  });

  test('a flag é consultada pelo servidor, nunca pelo store local', () => {
    assert.doesNotMatch(SYNC, /rotas_habilitadas|_flagVendaV1/);
  });
});

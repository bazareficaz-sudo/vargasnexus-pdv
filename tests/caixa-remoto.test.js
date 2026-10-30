const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { uuidDe, traduzir } = require('../src/main/caixaRemoto');

// O CAIXA PELO TERMINAL — as duas partes que decidem sozinhas.
//
// O resto do arquivo é telefone: monta o corpo e chama a rota. O que tem
// consequência própria é (1) o identificador derivado, que decide se uma
// retentativa transfere dinheiro de novo, e (2) a tradução da recusa, que
// decide o que o operador lê quando não dá.

describe('o identificador derivado', () => {
  test('é estável: o mesmo texto dá sempre o mesmo id', () => {
    // É a razão de ele existir. Se variasse, o segundo clique do fechamento
    // mandaria OUTRO `transferencia_id` e a entrega à tesouraria aconteceria
    // duas vezes — `transferir_caixa_v1` só reconhece o repetido pelo id.
    const a = uuidDe('fechamento:11111111-1111-4111-8111-111111111111');
    const b = uuidDe('fechamento:11111111-1111-4111-8111-111111111111');
    assert.equal(a, b);
  });

  test('textos diferentes dão ids diferentes', () => {
    assert.notEqual(
      uuidDe('fechamento:11111111-1111-4111-8111-111111111111'),
      uuidDe('fechamento:22222222-2222-4222-8222-222222222222'),
    );
  });

  test('abertura e fechamento da mesma sessão não colidem', () => {
    const sessao = '33333333-3333-4333-8333-333333333333';
    assert.notEqual(uuidDe(`abertura:${sessao}`), uuidDe(`fechamento:${sessao}`));
  });

  test('é um UUID bem formado, versão 4', () => {
    // O Postgres recusa o que não for UUID válido, e a recusa viria como erro
    // de transação no meio de um fechamento — o pior lugar para descobrir.
    const id = uuidDe('qualquer coisa');
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('a recusa, no português do balcão', () => {
  test('sem rede: diz que o caixa parou E que a venda continua', () => {
    // As duas metades são obrigatórias. Sem a segunda, o operador acha que o
    // PDV caiu inteiro e para de vender — o que custa mais que o caixa.
    const r = traduzir({ ok: false, motivo: 'rede', erro: 'fetch failed' });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'offline');
    assert.match(r.erro, /internet/);
    assert.match(r.erro, /vendas continuam/);
  });

  test('rota desligada manda falar com o gerente, não parecer defeito', () => {
    const r = traduzir({ ok: false, motivo: 'rota_desligada', erro: 'HTTP 403' });
    assert.equal(r.motivo, 'nao_liberado');
    assert.match(r.erro, /gerente/);
  });

  test('terminal não ativado é dito como é', () => {
    const r = traduzir({ ok: false, motivo: 'sem_identidade', erro: 'Terminal não ativado' });
    assert.equal(r.motivo, 'sem_identidade');
  });

  test('a recusa do servidor passa inteira, com o corpo', () => {
    // A tela precisa do `corpo` para distinguir "já estava registrada" de uma
    // recusa de verdade sem adivinhar pela mensagem.
    const r = traduzir({
      ok: false, motivo: 'sem_permissao', erro: 'Você não tem permissão para fechar o caixa. Peça ao gerente.',
      status: 403, corpo: { motivo: 'sem_permissao' },
    });
    assert.equal(r.motivo, 'sem_permissao');
    assert.match(r.erro, /gerente/);
    assert.deepEqual(r.corpo, { motivo: 'sem_permissao' });
  });

  test('motivo desconhecido não vira sucesso nem mensagem vazia', () => {
    const r = traduzir({ ok: false });
    assert.equal(r.ok, false);
    assert.equal(r.motivo, 'recusado');
    assert.ok(r.erro.length > 0);
  });
});

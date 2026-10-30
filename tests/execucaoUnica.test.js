const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { criarExecucaoUnica } = require('../src/renderer/lib/execucaoUnica');

// A TRAVA DE EXECUÇÃO ÚNICA.
//
// A 0.6D.0 mediu 7 pares de vendas duplicadas em produção. Duas das causas
// estão do lado do Electron e nenhuma proteção do servidor resolve:
//
//   1. Enter e clique chamam `_finalizarComVendedor` direto (pdv.js:1661 e
//      :1668), e a função tem um `await` logo na primeira linha — dá tempo
//      de a segunda chamada entrar antes de a primeira fechar o modal;
//   2. `syncFila` é disparada a cada venda (main.js:374) e lê `isSyncing`
//      sem nunca marcá-la — duas rodadas leem a MESMA fila pendente.
//
// Este arquivo prova o mecanismo que fecha as duas.

// Simula o que `db.vendas.registrar` faz: devolve uma venda nova a cada
// chamada, com um pequeno atraso (o IPC real também não é instantâneo).
function criarRegistradorFake() {
  let n = 0;
  const registradas = [];
  async function registrar() {
    await new Promise(r => setTimeout(r, 10));
    n += 1;
    const venda = { id: `uuid-${n}`, numero: 100000 + n };
    registradas.push(venda);
    return venda;
  }
  return { registrar, registradas };
}

describe('a prova do defeito — sem trava, duas chamadas viram duas vendas', () => {
  test('SEM TRAVA: Enter + clique registram DUAS vendas, com dois UUIDs', async () => {
    const { registrar, registradas } = criarRegistradorFake();

    // É exatamente o que acontece hoje: nada coordena as duas entradas.
    await Promise.all([registrar(), registrar()]);

    assert.equal(registradas.length, 2);
    assert.notEqual(registradas[0].id, registradas[1].id);
    assert.notEqual(registradas[0].numero, registradas[1].numero);
  });

  test('COM TRAVA: as mesmas duas chamadas registram UMA venda só', async () => {
    const { registrar, registradas } = criarRegistradorFake();
    const trava = criarExecucaoUnica();

    const a = trava(() => registrar());
    const b = trava(() => registrar());

    await Promise.all([a.promise, b.promise]);

    assert.equal(registradas.length, 1);
    assert.equal(a.entrou, true);
    assert.equal(b.entrou, false, 'a segunda chamada não pode entrar no caminho de escrita');
  });
});

describe('entrada e no-op', () => {
  test('a primeira chamada entra', () => {
    const trava = criarExecucaoUnica();
    assert.equal(trava(async () => 'ok').entrou, true);
  });

  test('a segunda chamada concorrente não entra e recebe a MESMA promise', () => {
    const trava = criarExecucaoUnica();
    const a = trava(() => new Promise(r => setTimeout(() => r('ok'), 10)));
    const b = trava(() => { throw new Error('esta função não pode nem ser chamada'); });

    assert.equal(b.entrou, false);
    assert.equal(b.promise, a.promise, 'quem chega depois se junta à execução em andamento');
  });

  test('a função da segunda chamada NÃO é executada', async () => {
    const trava = criarExecucaoUnica();
    let chamou = false;
    const a = trava(() => new Promise(r => setTimeout(() => r('ok'), 10)));
    trava(() => { chamou = true; });
    await a.promise;
    assert.equal(chamou, false);
  });

  test('três chamadas simultâneas: uma executa, duas se juntam', async () => {
    const trava = criarExecucaoUnica();
    let execucoes = 0;
    const fn = () => { execucoes += 1; return new Promise(r => setTimeout(() => r(execucoes), 10)); };

    const resultados = [trava(fn), trava(fn), trava(fn)];
    await Promise.all(resultados.map(r => r.promise));

    assert.equal(execucoes, 1);
    assert.deepEqual(resultados.map(r => r.entrou), [true, false, false]);
  });
});

describe('a trava sempre libera — nada de deadlock permanente', () => {
  test('sucesso libera', async () => {
    const trava = criarExecucaoUnica();
    await trava(async () => 'ok').promise;
    assert.equal(trava(async () => 'de novo').entrou, true);
  });

  test('ERRO ASSÍNCRONO libera', async () => {
    const trava = criarExecucaoUnica();
    const r = trava(async () => { throw new Error('rede caiu'); });
    await assert.rejects(r.promise, /rede caiu/);
    assert.equal(trava(async () => 'ok').entrou, true, 'depois de falhar, o operador tem que poder tentar de novo');
  });

  test('ERRO SÍNCRONO libera', async () => {
    const trava = criarExecucaoUnica();
    const r = trava(() => { throw new Error('estourou antes do await'); });
    await assert.rejects(r.promise, /estourou antes do await/);
    assert.equal(trava(async () => 'ok').entrou, true);
  });

  test('a venda que falha ANTES de gravar pode ser refeita', async () => {
    // Cenário real: o vendedor digita errado, a validação estoura, ele
    // corrige e finaliza de novo. Se a trava não liberasse, o PDV ficaria
    // travado até reiniciar — pior que o defeito que ela conserta.
    const trava = criarExecucaoUnica();
    const primeira = trava(async () => { throw new Error('código de vendedor inválido'); });
    await assert.rejects(primeira.promise);

    const segunda = trava(async () => ({ id: 'uuid-1', numero: 100001 }));
    assert.equal(segunda.entrou, true);
    assert.deepEqual(await segunda.promise, { id: 'uuid-1', numero: 100001 });
  });

  test('promise descartada que rejeita não vira unhandled rejection', async () => {
    // O caminho no-op descarta a promise de propósito. Se a trava não
    // tratasse a rejeição internamente, uma falha de rede no sync viraria
    // um unhandledRejection capaz de derrubar o processo main.
    const trava = criarExecucaoUnica();
    let capturou = null;
    const aoFalhar = (err) => { capturou = err; };
    process.once('unhandledRejection', aoFalhar);

    trava(async () => { throw new Error('falha descartada'); });
    await new Promise(r => setTimeout(r, 50));

    process.removeListener('unhandledRejection', aoFalhar);
    assert.equal(capturou, null);
  });
});

describe('chamadas sequenciais não são bloqueadas', () => {
  test('duas vendas seguidas, uma depois da outra, registram as duas', async () => {
    // A trava é contra concorrência, não contra vender rápido. Dois clientes
    // seguidos no balcão têm que virar duas vendas.
    const { registrar, registradas } = criarRegistradorFake();
    const trava = criarExecucaoUnica();

    await trava(() => registrar()).promise;
    await trava(() => registrar()).promise;

    assert.equal(registradas.length, 2);
  });
});

describe('travas independentes', () => {
  test('uma trava não bloqueia a outra', async () => {
    const travaVenda = criarExecucaoUnica();
    const travaSync = criarExecucaoUnica();
    const venda = travaVenda(() => new Promise(r => setTimeout(r, 10)));
    const sync = travaSync(() => new Promise(r => setTimeout(r, 10)));
    assert.equal(venda.entrou, true);
    assert.equal(sync.entrou, true);
    await Promise.all([venda.promise, sync.promise]);
  });
});

describe('a trava é do processo, e morre com ele', () => {
  test('uma trava nova nasce livre — restart nunca herda trava presa', () => {
    // Documenta a fronteira: reiniciar o Electron é o que "solta" qualquer
    // trava, porque ela nunca esteve em disco. A fila pendente continua no
    // SQLite e segue recuperável por `recuperarVendasPendentes`.
    const antes = criarExecucaoUnica();
    antes(() => new Promise(() => {})); // nunca resolve — processo "morreu" aqui

    const depoisDoRestart = criarExecucaoUnica();
    assert.equal(depoisDoRestart(async () => 'ok').entrou, true);
  });
});

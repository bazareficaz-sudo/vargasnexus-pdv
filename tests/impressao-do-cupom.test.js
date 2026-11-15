const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ONDE O CUPOM VAI, E SE ELE SAIU.
//
// O defeito que originou estes testes: apertar [P] no comprovante avisava
// "Enviado para impressao" e nada saia, enquanto o mesmo cupom, impresso pela
// tela de Vendas, saia normalmente. Duas causas somadas:
//
//   1. cada tela decidia SOZINHA para onde mandar -- o comprovante perguntava
//      ao main (`print:destino`), a tela de Vendas lia `print_server_ip`. No
//      terminal que HOSPEDA o servidor de impressao as duas respondem
//      diferente, e so uma delas acertava.
//
//   2. a rota local era disparada sem `await` e sem olhar a resposta, entao
//      o sucesso era anunciado antes (e independentemente) de imprimir.
//
// Por isso os testes abaixo executam a funcao DE VERDADE, tirada do fonte: o
// que precisa ficar provado e o desfecho que ela devolve, nao o texto dela.

const APP = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/renderer/app.js'), 'utf8');
const COMPONENTS = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/renderer/styles/components.js'), 'utf8');
const PDV = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/renderer/pages/pdv.js'), 'utf8');
const PRINT_SERVER = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/main/print-server.js'), 'utf8');

/** Recorta uma funcao do fonte contando chaves a partir do corpo. */
function extrair(fonte, assinatura) {
  const i = fonte.indexOf(assinatura);
  assert.notEqual(i, -1, `nao achei no fonte: ${assinatura}`);
  let nivel = 0, j = fonte.indexOf('{', i + assinatura.length - 1);
  for (; j < fonte.length; j++) {
    if (fonte[j] === '{') nivel++;
    else if (fonte[j] === '}') { nivel--; if (nivel === 0) break; }
  }
  return fonte.slice(i, j + 1);
}

/**
 * Objetos vindos do `vm` tem outro prototipo, entao `deepEqual` estrito
 * recusa ate o que e igual. O que importa aqui sao os campos.
 */
function conferir(real, esperado) {
  assert.deepEqual({ ...real }, esperado);
}

/**
 * `imprimirCupom` rodando de verdade, com o `window.pdv.print` que o teste
 * quiser. Devolve tambem o registro do que foi chamado -- e assim que se
 * prova que a rota local NAO passa pelo servidor, e vice-versa.
 */
function montarImprimirCupom(print) {
  const chamadas = [];
  const janela = {
    pdv: {
      print: {
        destino: async () => { chamadas.push(['destino']); return print.destino(); },
        servidor: async (d) => { chamadas.push(['servidor', d]); return print.servidor(d); },
        local: async (d) => { chamadas.push(['local', d]); return print.local(d); },
      },
    },
  };
  const ctx = vm.createContext({ window: janela, console });
  vm.runInContext(extrair(APP, 'function lerDesfechoDaImpressao(res)'), ctx);
  vm.runInContext(extrair(APP, 'async function imprimirCupom(dados)'), ctx);
  return { executar: (d) => vm.runInContext('imprimirCupom', ctx)(d), chamadas };
}

describe('uma decisao so sobre onde imprimir', () => {
  test('as duas telas chamam o MESMO despachante', () => {
    // Era aqui que a divergencia morava. Se alguem voltar a ler o IP em uma
    // das telas, elas tornam a discordar no terminal que hospeda o servidor.
    assert.match(COMPONENTS, /async _enviarImpressao\(dados\) \{\s*const r = await imprimirCupom\(dados\);/);
    assert.match(PDV, /const r = await imprimirCupom\(dados\);/);
  });

  test('nenhuma tela decide o destino lendo print_server_ip por conta propria', () => {
    const resto = COMPONENTS.slice(COMPONENTS.indexOf('const Vendas = {'));
    // Ate a proxima declaracao de topo. Um `\n};` sozinho casa com objeto
    // aninhado e arrastaria a tela de Configuracoes junto -- e la o IP pode,
    // e deve, aparecer, porque e onde ele e configurado.
    const fim = resto.search(/\nconst [A-Z]/);
    const corpoVendas = fim > 0 ? resto.slice(0, fim) : resto;
    // A tela de Configuracoes continua podendo ler e gravar o IP; o que nao
    // pode e a tela de Vendas (ou o PDV) LER o IP para escolher a rota. Os
    // comentarios podem cita-lo a vontade -- e justamente deles que vem a
    // explicacao do defeito.
    const leituraDoIp = /config\.get\(\s*['"]config\.print_server_ip['"]/;
    assert.doesNotMatch(corpoVendas, leituraDoIp);
    assert.doesNotMatch(PDV, leituraDoIp);
  });

  test('no terminal que hospeda o servidor, imprime local e NAO passa pelo tunel', async () => {
    // `destinoImpressao()` responde 'local' quando `print_server_ativo` e
    // true: dar a volta pelo tunel ate a propria maquina seria absurdo. A
    // tela de Vendas nao sabia disso e mandava pelo tunel.
    const { executar, chamadas } = montarImprimirCupom({
      destino: () => 'local',
      local: () => ({ success: true }),
      servidor: () => { throw new Error('nao devia chamar o servidor'); },
    });
    conferir(await executar({ numero: 1 }), { ok: true });
    assert.deepEqual(chamadas.map(c => c[0]), ['destino', 'local']);
  });

  test('com IP configurado e sem hospedar servidor, vai pelo servidor', async () => {
    const { executar, chamadas } = montarImprimirCupom({
      destino: () => 'servidor',
      servidor: () => ({ ok: true }),
      local: () => { throw new Error('nao devia imprimir local'); },
    });
    conferir(await executar({ numero: 1 }), { ok: true });
    assert.deepEqual(chamadas.map(c => c[0]), ['destino', 'servidor']);
  });

  test('o cupom chega inteiro ao destino, sem o despachante mexer nele', async () => {
    const cupom = { numero: 7, itens: [{ produto_nome: 'BUCHA' }], entrega: null };
    const { executar, chamadas } = montarImprimirCupom({
      destino: () => 'servidor', servidor: () => ({ ok: true }), local: () => ({}),
    });
    await executar(cupom);
    assert.equal(chamadas[1][1], cupom);
  });
});

describe('o desfecho da impressao e o de verdade', () => {
  test('impressora recusou: falha COM o motivo, nao "enviado"', async () => {
    // O caso do defeito. Antes: `print.local(dados)` sem await, sucesso
    // anunciado de qualquer jeito.
    const { executar } = montarImprimirCupom({
      destino: () => 'local',
      local: () => ({ success: false, failureReason: 'Impressora nao encontrada' }),
      servidor: () => ({}),
    });
    conferir(await executar({}), { ok: false, erro: 'Impressora nao encontrada' });
  });

  test('impressora recusou sem dizer por que: ainda assim e falha', async () => {
    const { executar } = montarImprimirCupom({
      destino: () => 'local', local: () => ({ success: false }), servidor: () => ({}),
    });
    const r = await executar({});
    assert.equal(r.ok, false);
    assert.ok(r.erro, 'a falha tem de vir com alguma explicacao');
  });

  test('servidor devolveu erro: falha COM o motivo', async () => {
    const { executar } = montarImprimirCupom({
      destino: () => 'servidor',
      servidor: () => ({ erro: 'Servidor retornou 502' }),
      local: () => ({}),
    });
    conferir(await executar({}), { ok: false, erro: 'Servidor retornou 502' });
  });

  test('main antigo, que nao devolve nada da rota local, NAO vira falha', async () => {
    // Enquanto os outros terminais nao forem atualizados, `print:local`
    // continua respondendo `undefined`. Silencio nao e recusa: inventar um
    // erro aqui assustaria o operador com uma impressao que saiu.
    const { executar } = montarImprimirCupom({
      destino: () => 'local', local: () => undefined, servidor: () => ({}),
    });
    conferir(await executar({}), { ok: true });
  });

  test('IPC fora do ar nao estoura na tela: vira falha com o motivo', async () => {
    const { executar } = montarImprimirCupom({
      destino: () => { throw new Error('canal fechado'); },
      local: () => ({}), servidor: () => ({}),
    });
    conferir(await executar({}), { ok: false, erro: 'canal fechado' });
  });
});

describe('o comprovante de entrega tambem para de mentir', () => {
  // Mesmo defeito, outro documento: `await print.entrega(dados)` e, logo
  // abaixo, "Comprovante enviado para impressao" sem olhar a resposta.
  const ENTREGAS = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/renderer/pages/entregas.js'), 'utf8');

  for (const [nome, fonte] of [['a tela de Entregas', () => ENTREGAS], ['o PDV', () => PDV]]) {
    test(`${nome} confere o desfecho antes de anunciar`, () => {
      const f = fonte();
      const i = f.indexOf('window.pdv.print.entrega(dados)');
      assert.notEqual(i, -1, 'a impressao de entrega sumiu');
      const trecho = f.slice(i - 200, i + 400);
      assert.match(trecho, /lerDesfechoDaImpressao/);
      assert.match(trecho, /if \(r\.ok\) Toast\.show/);
    });
  }

  test('as duas formas de resposta sao entendidas pelo mesmo tradutor', () => {
    const ctx = vm.createContext({});
    vm.runInContext(extrair(APP, 'function lerDesfechoDaImpressao(res)'), ctx);
    const ler = vm.runInContext('lerDesfechoDaImpressao', ctx);
    // A rota pelo servidor fala `erro`; a rota local fala `success`.
    assert.equal(ler({ erro: 'tunel caiu' }).erro, 'tunel caiu');
    assert.equal(ler({ success: false, failureReason: 'Sem papel' }).erro, 'Sem papel');
    assert.equal(ler({ success: true }).ok, true);
    assert.equal(ler({ ok: true, posicao_fila: 1 }).ok, true);
    // Silencio nao e recusa: terminal ainda nao atualizado.
    assert.equal(ler(undefined).ok, true);
  });
});

describe('a fila de impressao devolve o desfecho de cada cupom', () => {
  // `adicionarNaFila` empilhava o job e devolvia `undefined`: o resultado de
  // `webContents.print` -- que existe e diz `success`/`failureReason` --
  // morria dentro de `processarFila`. Era a origem do "enviado" mentiroso.
  function montarFila(imprimir) {
    const ctx = vm.createContext({ console, setImmediate, setTimeout });
    vm.runInContext(
      'const fila = [];\n'
      + 'let imprimindo = false;\n'
      + 'const imprimirLocal = ' + imprimir + ';\n'
      + extrair(PRINT_SERVER, 'async function processarFila()') + '\n'
      + extrair(PRINT_SERVER, 'function adicionarNaFila(dados)') + '\n',
      ctx);
    return (d) => vm.runInContext('adicionarNaFila', ctx)(d);
  }

  test('devolve sucesso quando o cupom sai', async () => {
    const fila = montarFila('async () => ({ success: true })');
    assert.equal((await fila({ numero: 1 })).success, true);
  });

  test('devolve o motivo quando nao sai', async () => {
    const fila = montarFila("async () => ({ success: false, failureReason: 'Sem papel' })");
    const r = await fila({ numero: 1 });
    assert.equal(r.success, false);
    assert.equal(r.failureReason, 'Sem papel');
  });

  test('excecao no job vira falha, e nao uma promessa pendurada para sempre', async () => {
    const fila = montarFila("async () => { throw new Error('janela destruida'); }");
    const r = await fila({ numero: 1 });
    assert.equal(r.success, false);
    assert.equal(r.failureReason, 'janela destruida');
  });

  test('cada cupom recebe o SEU desfecho, na ordem, um de cada vez', async () => {
    // A fila existe para nao abrir duas janelas de impressao ao mesmo tempo.
    // Devolver o desfecho nao pode custar essa garantia nem trocar as
    // respostas entre dois cupons enfileirados juntos.
    const fila = montarFila(
      'async (d) => {\n'
      + "  if (globalThis.__emVoo) throw new Error('dois jobs ao mesmo tempo');\n"
      + '  globalThis.__emVoo = true;\n'
      + '  await new Promise(r => setTimeout(r, 5));\n'
      + '  globalThis.__emVoo = false;\n'
      + "  return { success: d.numero % 2 === 1, failureReason: 'n' + d.numero };\n"
      + '}');
    const [a, b, c] = await Promise.all([
      fila({ numero: 1 }), fila({ numero: 2 }), fila({ numero: 3 }),
    ]);
    assert.equal(a.success, true);
    assert.equal(b.success, false);
    assert.equal(b.failureReason, 'n2');
    assert.equal(c.success, true);
  });
});

describe('o servidor de impressao nao promete pelo outro', () => {
  const ROTA = PRINT_SERVER.slice(PRINT_SERVER.indexOf("req.url === '/imprimir'"));

  test('a rota /imprimir espera o desfecho antes de responder', () => {
    // Responder `ok: true` ao enfileirar fazia o terminal que vendeu avisar
    // "Enviado para impressao" enquanto, do outro lado, o job falhava calado.
    assert.match(ROTA, /await Promise\.race\(\[\s*adicionarNaFila\(dados\)/);
    assert.match(ROTA, /desfecho\.success/);
  });

  test('impressora travada nao prende o balcao: ha teto de espera', () => {
    assert.match(ROTA, /TETO_MS = 8000/);
    // Estourou o teto, a resposta nao afirma nem sucesso nem fracasso.
    assert.match(ROTA, /pendente: true/);
  });

  test('quem envia espera mais do que o teto do outro lado', () => {
    // 6s de timeout com 8s de teto desistiria no instante em que o servidor
    // ia contar se o cupom saiu -- e toda impressao viraria "erro de rede".
    const envio = extrair(PRINT_SERVER, 'async function enviarParaServidor(dados)');
    const m = envio.match(/timeout:\s*(\d+)/);
    assert.ok(m, 'o envio perdeu o timeout');
    assert.ok(Number(m[1]) > 8000, `timeout ${m[1]}ms e menor que o teto de 8000ms do servidor`);
  });
});

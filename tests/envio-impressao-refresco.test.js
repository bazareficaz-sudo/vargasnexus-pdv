const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { enviarComRefresco } = require('../src/main/envioImpressao');

// A SEGUNDA TENTATIVA, QUANDO O CAIXA TROCA DE ENDERECO.
//
// O Quick Tunnel ganha URL nova a cada reinicio do CAIXA. Os outros terminais
// so descobrem no sync seguinte — ate cinco minutos depois. Nessa janela eles
// mandam o job para um endereco que ja nao existe.
//
// Medido em producao em 15/10: a URL publicada era
// `tuesday-accept-membrane-jenny`, e o terminal tinha exatamente essa. A
// corrente funciona; o que falta e o que fazer DENTRO da janela.
//
// Testes de comportamento: nenhum Electron, nenhuma rede, nenhum CAIXA do
// outro lado. So as decisoes.

/** Monta um cenario com contadores, para provar quantas vezes cada coisa roda. */
function cenario({ falhas = 0, urlAtual = 'https://velho.trycloudflare.com', urlNova = null, buscaExplode = false } = {}) {
  const c = { envios: 0, buscas: 0, salvou: null, logou: null, recebido: [] };
  let restam = falhas;
  return {
    c,
    deps: {
      enviar: async (dados) => {
        c.envios += 1;
        c.recebido.push(dados);
        if (restam > 0) { restam -= 1; throw new Error(`falha ${c.envios}`); }
        return { ok: true, tentativa: c.envios };
      },
      lerUrlAtual: () => (c.salvou ?? urlAtual),
      buscarUrlNova: async () => {
        c.buscas += 1;
        if (buscaExplode) throw new Error('servidor fora');
        return urlNova;
      },
      salvarUrl: (u) => { c.salvou = u; },
      log: (u) => { c.logou = u; },
    },
  };
}

const JOB = { numero: 7, _html: '<b>x</b>' };

describe('o caminho feliz nao paga nada', () => {
  test('enviou de primeira: uma chamada, nenhuma busca', () => {
    // O custo do conserto tem de ser zero quando nao ha nada a consertar.
    const { c, deps } = cenario();
    return enviarComRefresco(JOB, deps).then((r) => {
      assert.deepEqual(r, { ok: true, tentativa: 1 });
      assert.equal(c.envios, 1);
      assert.equal(c.buscas, 0);
      assert.equal(c.salvou, null);
    });
  });
});

describe('endereco novo: rebusca e tenta de novo', () => {
  test('a segunda tentativa funciona', async () => {
    const { c, deps } = cenario({ falhas: 1, urlNova: 'https://novo.trycloudflare.com' });
    const r = await enviarComRefresco(JOB, deps);
    assert.deepEqual(r, { ok: true, tentativa: 2 });
    assert.equal(c.envios, 2);
    assert.equal(c.buscas, 1);
  });

  test('a URL nova fica SALVA, nao so usada', () => {
    // Senao a proxima impressao repetiria a mesma falha e a mesma espera.
    const { c, deps } = cenario({ falhas: 1, urlNova: 'https://novo.trycloudflare.com' });
    return enviarComRefresco(JOB, deps).then(() => {
      assert.equal(c.salvou, 'https://novo.trycloudflare.com');
      assert.equal(c.logou, 'https://novo.trycloudflare.com');
    });
  });

  test('o MESMO job é reenviado, nao um pedaco dele', async () => {
    const { c, deps } = cenario({ falhas: 1, urlNova: 'https://novo.trycloudflare.com' });
    await enviarComRefresco(JOB, deps);
    assert.deepEqual(c.recebido[0], JOB);
    assert.deepEqual(c.recebido[1], JOB);
  });
});

describe('quando NAO vale a pena tentar de novo', () => {
  test('mesma URL: o endereco nao era o problema', async () => {
    // CAIXA desligado, impressora sem papel, rede fora. Repetir daria o mesmo
    // erro dois segundos mais tarde, com o cliente esperando.
    const { c, deps } = cenario({ falhas: 1, urlAtual: 'https://igual.trycloudflare.com',
                                  urlNova: 'https://igual.trycloudflare.com' });
    await assert.rejects(() => enviarComRefresco(JOB, deps), /falha 1/);
    assert.equal(c.envios, 1, 'nao podia ter tentado de novo');
  });

  test('sem URL publicada: nada a trocar', async () => {
    const { c, deps } = cenario({ falhas: 1, urlNova: null });
    await assert.rejects(() => enviarComRefresco(JOB, deps), /falha 1/);
    assert.equal(c.envios, 1);
  });

  test('servidor fora: sobe o erro da IMPRESSAO, nao o da consulta', async () => {
    // "erro ao buscar URL" mandaria quem investiga para o lugar errado.
    const { c, deps } = cenario({ falhas: 1, buscaExplode: true });
    await assert.rejects(() => enviarComRefresco(JOB, deps), /falha 1/);
    assert.equal(c.envios, 1);
  });
});

describe('uma tentativa a mais, e so uma', () => {
  test('se a segunda tambem falhar, desiste', async () => {
    // Insistir faria o caixa esperar mais. O erro que sobe é o da SEGUNDA:
    // é o mais recente e descreve o endereco que esta valendo agora.
    const { c, deps } = cenario({ falhas: 2, urlNova: 'https://novo.trycloudflare.com' });
    await assert.rejects(() => enviarComRefresco(JOB, deps), /falha 2/);
    assert.equal(c.envios, 2, 'no maximo duas tentativas');
    assert.equal(c.buscas, 1, 'rebusca uma vez so');
  });

  test('nao entra em laco mesmo com a URL mudando sempre', async () => {
    // Um tunel instavel republicando a cada segundo nao pode virar um loop
    // que segura o caixa para sempre.
    let n = 0;
    const deps = {
      enviar: async () => { n += 1; throw new Error('sempre falha'); },
      lerUrlAtual: () => 'https://a.trycloudflare.com',
      buscarUrlNova: async () => `https://nova-${n}.trycloudflare.com`,
      salvarUrl: () => {},
    };
    await assert.rejects(() => enviarComRefresco(JOB, deps), /sempre falha/);
    assert.equal(n, 2);
  });
});

describe('sem as dependencias, nao explode', () => {
  test('falta de buscarUrlNova apenas impede a segunda tentativa', async () => {
    let n = 0;
    await assert.rejects(
      () => enviarComRefresco(JOB, { enviar: async () => { n += 1; throw new Error('x'); } }),
      /x/);
    assert.equal(n, 1);
  });
});

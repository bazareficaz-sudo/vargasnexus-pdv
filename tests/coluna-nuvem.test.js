const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A COLUNA NUVEM DA TELA DE VENDAS.
//
// O defeito: uma venda feita neste terminal, que subiu para o servidor sem
// problema nenhum, aparecia com "X Erro". Clicar em reenviar respondia "Venda
// sincronizada!" e a linha continuava vermelha.
//
// A causa e fina e vale escrever por extenso. Quem tem permissao de ver todos
// os terminais recebe a lista DO SERVIDOR. O registro do servidor nao tem
// `remote_id` nem `sync_status` -- sao colunas do SQLite local, nao da nuvem.
// O badge lia esses dois campos do registro da lista e caia no ultimo ramo.
//
// Logo: a venda aparecia como erro EXATAMENTE PORQUE tinha sincronizado --
// so quem sincroniza volta na resposta da nuvem. E a venda que de fato
// falhou nem aparecia na tela, porque o servidor nao a conhece.

const FONTE = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/renderer/styles/components.js'), 'utf8');
const SYNC = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/main/sync.js'), 'utf8');

/** Recorta um metodo do objeto `Vendas` e o executa de verdade. */
function metodo(assinatura) {
  const i = FONTE.indexOf('\n  ' + assinatura);
  assert.notEqual(i, -1, `nao achei o metodo: ${assinatura}`);
  let nivel = 0, j = FONTE.indexOf('{', i + assinatura.length);
  for (; j < FONTE.length; j++) {
    if (FONTE[j] === '{') nivel++;
    else if (FONTE[j] === '}') { nivel--; if (nivel === 0) break; }
  }
  const corpo = FONTE.slice(i + 3, j + 1);
  const ctx = vm.createContext({ console });
  vm.runInContext(`const Vendas = { ${corpo} };`, ctx);
  const nome = assinatura.slice(0, assinatura.indexOf('('));
  return (...args) => vm.runInContext('Vendas', ctx)[nome](...args);
}

const badgeNuvem = metodo('_badgeNuvem(id, local)');
const juntar = metodo('_juntarLocaisForaDaNuvem(lista, locais, terminalId)');

describe('o badge le o registro LOCAL, nunca o da nuvem', () => {
  // O registro que o Supabase devolve. Repare: sem `remote_id`, sem
  // `sync_status`. Nao e descuido do teste -- as colunas nao existem la.
  const DA_NUVEM = {
    id: '02bdb657-5a0f-4354-aefd-e9ac1817519f',
    numero: 100017, total: 0.2, terminal_id: 'YOGA', status: 'concluida',
  };

  test('venda deste terminal que JA subiu aparece como sincronizada', () => {
    // O caso exato relatado: venda 100017, remote_id gravado, sync_status
    // 'synced' -- e a tela dizia "Erro".
    const local = { ...DA_NUVEM, remote_id: DA_NUVEM.id, sync_status: 'synced' };
    const html = badgeNuvem(DA_NUVEM.id, local);
    assert.match(html, /Sync/);
    assert.doesNotMatch(html, /Erro/);
  });

  test('e sem oferecer o botao de reenviar o que ja esta enviado', () => {
    // O botao era o que fechava o circulo da confusao: reenviava, respondia
    // "sincronizada" e nada mudava, porque nada havia para mudar.
    const local = { ...DA_NUVEM, remote_id: DA_NUVEM.id, sync_status: 'synced' };
    assert.doesNotMatch(badgeNuvem(DA_NUVEM.id, local), /retentarSync/);
  });

  test('venda de OUTRO terminal conta como sincronizada', () => {
    // Nao ha registro local dela. Estar na resposta do servidor ja prova que
    // subiu -- e imprimir ou editar daqui nao seria possivel de todo jeito.
    const html = badgeNuvem('id-de-outro-balcao', undefined);
    assert.match(html, /Sync/);
    assert.doesNotMatch(html, /retentarSync/);
  });

  test('venda local esperando a fila aparece como pendente, com reenviar', () => {
    const html = badgeNuvem('x', { remote_id: null, sync_status: 'pending' });
    assert.match(html, /Pendente/);
    assert.match(html, /retentarSync\('x'\)/);
  });

  test('venda local que falhou aparece como erro, com reenviar', () => {
    const html = badgeNuvem('y', { remote_id: null, sync_status: 'erro' });
    assert.match(html, /Erro/);
    assert.match(html, /retentarSync\('y'\)/);
  });

  test('o badge nao olha o registro da nuvem por acidente', () => {
    // Se alguem voltar a passar `v` no lugar de `local`, este teste cai:
    // o registro da nuvem nao tem remote_id, logo o badge diria "Erro".
    const corpo = FONTE.slice(FONTE.indexOf('_badgeNuvem(id, local)'));
    const ateOFim = corpo.slice(0, corpo.indexOf('\n  },'));
    assert.doesNotMatch(ateOFim, /\bv\./);
  });
});

describe('a venda que nao subiu nao pode sumir da tela', () => {
  // O avesso do defeito acima, e mais grave: a lista vem do servidor, entao
  // a venda que falhou ao subir simplesmente nao estava nela. O gerente via
  // todas as vendas MENOS as que precisavam dele.
  const naNuvem = [{ id: 'A', numero: 1 }, { id: 'B', numero: 2 }];

  test('a venda local ausente da nuvem entra na lista', () => {
    const locais = new Map([
      ['A', { id: 'A', numero: 1, remote_id: 'A' }],
      ['C', { id: 'C', numero: 3, remote_id: null, sync_status: 'erro' }],
    ]);
    const r = juntar(naNuvem, locais, 'YOGA');
    assert.equal(r.length, 3);
    assert.deepEqual(r.map(v => v.id), ['A', 'B', 'C']);
  });

  test('e entra carimbada com o terminal desta maquina', () => {
    // O SQLite local nao guarda `terminal_id`: sem isto a coluna Terminal
    // ficaria com um tracinho justamente na linha que pede atencao.
    const locais = new Map([['C', { id: 'C', remote_id: null }]]);
    assert.equal(juntar([], locais, 'YOGA')[0].terminal_id, 'YOGA');
  });

  test('sem nome de terminal configurado, nao inventa um', () => {
    const locais = new Map([['C', { id: 'C', remote_id: null }]]);
    assert.equal(juntar([], locais, undefined)[0].terminal_id, null);
  });

  test('venda ja sincronizada nao aparece duas vezes', () => {
    const locais = new Map([['A', { id: 'A', remote_id: 'A' }]]);
    assert.equal(juntar(naNuvem, locais, 'YOGA').length, 2);
  });

  test('venda ANTIGA, com id local diferente do remoto, tambem nao duplica', () => {
    // Antes do protocolo V1 os dois ids eram diferentes. Parear so por `id`
    // faria toda venda antiga ja sincronizada aparecer em dobro na tela.
    const locais = new Map([
      ['local-1', { id: 'local-1', remote_id: 'A' }],
    ]);
    assert.equal(juntar(naNuvem, locais, 'YOGA').length, 2);
  });

  test('nada a juntar devolve a mesma lista', () => {
    assert.equal(juntar(naNuvem, new Map(), 'YOGA').length, 2);
  });

  test('aguenta lista ou mapa ausentes sem quebrar a tela', () => {
    assert.equal(juntar(undefined, undefined, 'YOGA').length, 0);
  });
});

describe('o reenvio manual responde a verdade', () => {
  // `retentarVendaManual` devolvia `{ ok: true }` em todos os desfechos,
  // inclusive naqueles em que a venda NAO sobe. Dai a contradicao na tela:
  // "Venda sincronizada!" com a coluna Nuvem vermelha do lado.
  function montar({ venda, vendaDepois, remoteId }) {
    const ctx = vm.createContext({
      console,
      db: { vendas: { getById: () => (ctx.__segunda ? vendaDepois : venda) } },
      _sincronizarVendaCreate: async () => { ctx.__segunda = true; return remoteId; },
    });
    const i = SYNC.indexOf('async function retentarVendaManual(vendaId)');
    assert.notEqual(i, -1, 'retentarVendaManual sumiu de sync.js');
    let nivel = 0, j = SYNC.indexOf('{', i);
    for (; j < SYNC.length; j++) {
      if (SYNC[j] === '{') nivel++;
      else if (SYNC[j] === '}') { nivel--; if (nivel === 0) break; }
    }
    vm.runInContext(SYNC.slice(i, j + 1), ctx);
    return () => vm.runInContext('retentarVendaManual', ctx)('id');
  }

  test('ja sincronizada: sucesso, mas dizendo que ja estava', async () => {
    // O que o operador viu. A mensagem agora corresponde ao que aconteceu --
    // nada -- em vez de sugerir um envio que nao houve.
    const r = await montar({ venda: { id: 'x', remote_id: 'R' } })();
    assert.equal(r.ok, true);
    assert.equal(r.jaEstava, true);
  });

  test('subiu agora: sucesso, e sem dizer que ja estava', async () => {
    const r = await montar({
      venda: { id: 'x', remote_id: null },
      vendaDepois: { id: 'x', remote_id: 'R' },
      remoteId: 'R',
    })();
    assert.equal(r.ok, true);
    assert.ok(!r.jaEstava);
    assert.equal(r.remoteId, 'R');
  });

  test('cancelada: NAO e sucesso, e diz por que', async () => {
    const r = await montar({
      venda: { id: 'x', remote_id: null, status: 'cancelada' },
      vendaDepois: { id: 'x', remote_id: null, status: 'cancelada' },
      remoteId: null,
    })();
    assert.equal(r.ok, false);
    assert.match(r.erro, /cancelada/i);
  });

  test('conflito de orcamento: NAO e sucesso, e avisa que nao sera reenviada', async () => {
    // Este e terminal de proposito -- o orcamento ja pertence a outra venda.
    // Dizer "sincronizada" aqui faria o operador clicar para sempre.
    const r = await montar({
      venda: { id: 'x', remote_id: null },
      vendaDepois: { id: 'x', remote_id: null, conflito_conversao: '{"tipo":"conflito_orcamento"}' },
      remoteId: null,
    })();
    assert.equal(r.ok, false);
    assert.match(r.erro, /conflito/i);
  });

  test('servidor nao confirmou: NAO e sucesso', async () => {
    const r = await montar({
      venda: { id: 'x', remote_id: null },
      vendaDepois: { id: 'x', remote_id: null },
      remoteId: null,
    })();
    assert.equal(r.ok, false);
    assert.ok(r.erro);
  });

  test('venda que nao existe mais: NAO e sucesso', async () => {
    const r = await montar({ venda: null })();
    assert.equal(r.ok, false);
    assert.ok(r.erro);
  });

  test('a tela distingue o reenvio do "ja estava"', () => {
    assert.match(FONTE, /r\.jaEstava \? 'Esta venda ja estava sincronizada' : 'Venda sincronizada!'/);
  });
});

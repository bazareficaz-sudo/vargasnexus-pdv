const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { criarComandoOrcamento } = require('../src/main/orcamentoComando');
const Acoes = require('../src/renderer/lib/acoesOrcamento');

// FASE 0.6C.5 — AÇÃO CRUZADA ONLINE SOBRE DOCUMENTO ALHEIO.
//
// Decisão de produto: o SQLite continua sendo cache de trabalho DESTE terminal.
// Um orçamento criado em outro terminal pode ser visto, editado e cancelado —
// online, pela rota autenticada, em cima de um snapshot atômico — mas NÃO vira
// documento local.
//
// A fronteira: `orcamento_itens` guarda itens de documentos que este terminal
// mantém. Payload de operação pendente é outra categoria de dado, e mora na
// fila.

const mudo = { log() {}, warn() {}, error() {} };

function apiFalsa(resposta) {
  const chamadas = [];
  return {
    chamadas, legado: [],
    salvarOrcamentoAutenticado: async (cmd) => { chamadas.push(cmd); return resposta; },
    montarPayloadOrcamentoRemoto: (p) => p,
    sincronizarOrcamento: async function (p) { this.legado.push(['criar', p]); return { id: 'x', numero: 1 }; },
    atualizarOrcamento: async function (r, d) { this.legado.push(['editar', r, d]); return { ok: true }; },
    atualizarStatusOrcamento: async function (r, st) { this.legado.push(['status', r, st]); return { ok: true }; },
  };
}
const terminalFalso = () => ({
  fallbacks: [],
  registrarFallback: async function (op, chave, motivo) { this.fallbacks.push({ op, chave, motivo }); },
});
/** O SQLite não é tocado por nenhum caminho alheio — este duplo prova isso. */
const bancoProibido = () => ({
  orcamentos: new Proxy({}, { get(_, k) { throw new Error(`SQLite tocado: orcamentos.${String(k)}`); } }),
  sync: new Proxy({}, { get(_, k) { throw new Error(`SQLite tocado: sync.${String(k)}`); } }),
});

const OK = (o = {}) => ({ tipo: 'ok', dados: { orcamento_id: 'r-1', numero: 42, revisao: 4, ...o } });
const OP = (o = {}) => ({
  orcamento_id: 'r-1', revisao_base: 3, acao: 'salvar', op_chave: 'r-1:r3:salvar',
  orc: { cliente_nome: 'Eliane', total: 100 }, itens: [{ produto_nome: 'CIMENTO', quantidade: 1, total: 100 }],
  ...o,
});
const comando = (api, term = terminalFalso()) =>
  criarComandoOrcamento({ db: bancoProibido(), api, terminal: term, log: mudo });

// ───────────────────────────────────────────────────────────────────────
describe('1-3. leitura: próprio, alheio online, alheio offline', () => {
  test('a tela distingue os três desfechos, e nenhum deles é mentira', () => {
    // O defeito antigo: falha de rede virava "Orçamento não encontrado" — uma
    // afirmação falsa sobre um documento que existe.
    const proprio = { id: 'loc-1', status: 'pendente' };
    const alheioCabecalho = { id: 'r-1', status: 'aberto', _origem: 'cloud' };
    const alheioSnapshot = { id: 'r-1', status: 'aberto', _origem: 'snapshot', revisao: 3 };

    assert.equal(Acoes.ehSomenteNuvem(alheioCabecalho), true, 'listagem: só cabeçalho');
    assert.equal(Acoes.ehSnapshotAlheio(alheioSnapshot), true, 'aberto online: snapshot completo');
    assert.equal(Acoes.ehSnapshotAlheio(proprio), false);
    assert.equal(Acoes.ehSomenteNuvem(proprio), false);
  });

  test('só o snapshot atômico habilita ação — o cabeçalho da lista não', () => {
    const cabecalho = { status: 'aberto', _origem: 'cloud' };
    assert.equal(Acoes.podeEditar(cabecalho), false);
    assert.equal(Acoes.podeCancelar(cabecalho), false);
  });
});

describe('4-5. snapshot e edição alheia', () => {
  test('a revisão do snapshot vai como revisao_base, e a chave junto', async () => {
    const api = apiFalsa(OK());
    const r = await comando(api).executarAlheio(OP());

    assert.equal(r.tipo, 'ok');
    assert.equal(api.chamadas.length, 1);
    assert.equal(api.chamadas[0].orcamento_id, 'r-1', 'identidade remota');
    assert.equal(api.chamadas[0].revisao_base, 3, 'a revisão que a tela leu');
    assert.equal(api.chamadas[0].idempotency_key, 'r-1:r3:salvar');
    assert.deepEqual(api.legado, [], 'nunca pelo legado');
  });

  test('o SQLite não é tocado em nenhum ponto do caminho alheio', async () => {
    // `bancoProibido` estoura em qualquer acesso. Se este teste passa, é
    // porque `executarAlheio` não leu nem escreveu documento local.
    const r = await comando(apiFalsa(OK())).executarAlheio(OP());
    assert.equal(r.tipo, 'ok');
  });
});

describe('6. cancelamento alheio', () => {
  test('usa identidade remota e revisão, sem depender de itens locais', async () => {
    const api = apiFalsa(OK({ revisao: 4 }));
    const r = await comando(api).executarAlheio(OP({ acao: 'cancelar', op_chave: 'r-1:r3:cancelar', itens: [] }));

    assert.equal(r.tipo, 'ok');
    assert.equal(api.chamadas[0].acao, 'cancelar');
    assert.equal(api.chamadas[0].idempotency_key, 'r-1:r3:cancelar', 'chave própria, não a de salvar');
    assert.equal(api.chamadas[0].revisao_base, 3);
  });
});

describe('7. conversão alheia continua BLOQUEADA (decisão D-a)', () => {
  test('snapshot alheio não oferece converter em venda', () => {
    const snapshot = { status: 'aberto', _origem: 'snapshot', revisao: 3 };
    assert.equal(Acoes.podeEditar(snapshot), true);
    assert.equal(Acoes.podeCancelar(snapshot), true);
    assert.equal(Acoes.podeConverter(snapshot), false,
      'marcarConvertido ainda é caminho legado com erro engolido — 0.6C.6');
  });

  test('documento próprio continua conversível', () => {
    assert.equal(Acoes.podeConverter({ status: 'pendente' }), true);
  });
});

describe('8. revisão divergente = 409, sem overwrite', () => {
  test('conflito não repete, não cai no legado, e é dito', async () => {
    const api = apiFalsa({ tipo: 'conflito', erro: 'conflito_versao' });
    const r = await comando(api).executarAlheio(OP());

    assert.equal(r.tipo, 'conflito');
    assert.deepEqual(api.legado, [], 'NÃO cai no legado — sobrescreveria a edição do outro');
    assert.equal(api.chamadas.length, 1, 'não insiste');
  });

  test('rota desligada NÃO vira gravação pelo legado', async () => {
    // O legado não valida revisão nenhuma. Usá-lo em documento alheio seria
    // sobrescrever em silêncio a edição de outro terminal.
    const api = apiFalsa({ tipo: 'legado', motivo: 'rota_desligada' });
    const term = terminalFalso();
    const r = await comando(api, term).executarAlheio(OP());

    assert.equal(r.tipo, 'indisponivel');
    assert.deepEqual(api.legado, [], 'recusa em vez de arriscar');
    assert.equal(term.fallbacks.length, 1, 'e o fallback é contado');
  });
});

describe('13-15. idempotência, retry e falha de rede', () => {
  test('a mesma chave nas duas tentativas — um efeito só', async () => {
    const api = apiFalsa({ tipo: 'erro', motivo: 'rede', erro: 'timeout' });
    const cmd = comando(api);
    const op = OP();

    const r1 = await cmd.executarAlheio(op);
    assert.equal(r1.tipo, 'erro', 'transitório: fica na fila');

    api.salvarOrcamentoAutenticado = async (c) => { api.chamadas.push(c); return OK({ repetido: true }); };
    const r2 = await cmd.executarAlheio(op);

    assert.equal(r2.tipo, 'ok');
    assert.equal(api.chamadas[0].idempotency_key, api.chamadas[1].idempotency_key,
      'a chave veio do disco, não foi recalculada');
    assert.equal(api.chamadas[1].revisao_base, 3, 'e a base continua a do snapshot');
  });

  test('reabrir a tela não muda a chave da operação pendente', async () => {
    const api = apiFalsa(OK({ repetido: true }));
    await comando(api).executarAlheio(OP({ op_chave: 'r-1:r3:salvar' }));
    assert.equal(api.chamadas[0].idempotency_key, 'r-1:r3:salvar');
  });

  test('ação desconhecida é recusada antes de qualquer rede', async () => {
    const api = apiFalsa(OK());
    await assert.rejects(() => comando(api).executarAlheio(OP({ acao: 'apagar' })));
    assert.equal(api.chamadas.length, 0);
  });

  test('operação sem identidade remota não vai para a rede', async () => {
    const api = apiFalsa(OK());
    const r = await comando(api).executarAlheio({ acao: 'salvar' });
    assert.equal(r.tipo, 'sem_orcamento');
    assert.equal(api.chamadas.length, 0);
  });
});

describe('9. FRONTEIRA ARQUITETURAL — teste estrutural', () => {
  // Este é o teste mais importante do conjunto: é o único que protege a
  // DECISÃO DE PRODUTO contra erosão. A fronteira hoje é consequência de dois
  // pontos de escrita; sem isto, um terceiro entraria sem ninguém decidir.
  const raiz = path.join(__dirname, '..', 'src');

  function arquivosJs(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      return e.isDirectory() ? arquivosJs(p) : (e.name.endsWith('.js') ? [p] : []);
    });
  }

  test('só `registrar()` e `atualizar()` escrevem em orcamento_itens', () => {
    const escritas = [];
    for (const arquivo of arquivosJs(raiz)) {
      const linhas = fs.readFileSync(arquivo, 'utf8').split('\n');
      linhas.forEach((linha, i) => {
        const semComentario = linha.replace(/^\s*(\/\/|\*).*/, '');
        if (!/orcamento_itens/.test(semComentario)) return;
        if (!/INSERT\s+INTO|DELETE\s+FROM|UPDATE\s+/i.test(semComentario)) return;
        // As escritas no SERVIDOR (supabase.from) são outra coisa: o documento
        // remoto é do servidor. A fronteira é sobre o SQLite local.
        if (/supabase\.from/.test(semComentario)) return;
        escritas.push(`${path.relative(raiz, arquivo)}:${i + 1}`);
      });
    }

    // Hoje: database.js — dentro de `registrar()` e de `atualizar()`.
    assert.equal(escritas.length, 3,
      `escritas locais em orcamento_itens mudaram: ${escritas.join(', ')}\n`
      + 'Se isto quebrou, alguém passou a persistir itens fora de registrar/atualizar. '
      + 'Isso muda o modelo de sincronização do produto e exige decisão arquitetural '
      + 'explícita — não é para ser consertado subindo o número.');
    assert.ok(escritas.every((e) => e.startsWith('main\\database.js') || e.startsWith('main/database.js')),
      `escrita de itens fora de database.js: ${escritas.join(', ')}`);
  });

  test('nenhum fluxo de down-sync ou leitura alheia menciona orcamento_itens', () => {
    for (const nome of ['main/sync.js', 'main/orcamentoSql.js', 'main/orcamentoComando.js']) {
      const arquivo = path.join(raiz, ...nome.split('/'));
      const corpo = fs.readFileSync(arquivo, 'utf8');
      const linhas = corpo.split('\n').filter((l) =>
        /orcamento_itens/.test(l) && /INSERT|DELETE|UPDATE/i.test(l) && !/^\s*(\/\/|\*)/.test(l));
      assert.deepEqual(linhas, [], `${nome} passou a escrever itens — ver o teste anterior`);
    }
  });
});

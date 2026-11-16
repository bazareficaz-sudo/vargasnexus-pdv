const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A NOTA DO BALCAO, EMITIDA PELO SERVIDOR.
//
// O que existia antes: `focusnfe.js` montava a NFC-e aqui dentro e falava
// direto com o provedor. Isso exigia o token fiscal no terminal -- credencial
// da conta, em seis maquinas de balcao -- e desde a migracao do Base44 nao
// havia mais token nenhum para ler, entao o botao [F] so sabia dizer "Token
// FocusNFe nao configurado".
//
// Estes testes executam as funcoes DE VERDADE, tiradas do fonte, e o que
// precisa ficar provado e: (1) o terminal nao conhece credencial fiscal,
// (2) ele nunca diz que emitiu sem o servidor ter dito, e (3) venda que ainda
// nao subiu recebe a explicacao certa em vez de um erro fiscal.

const raiz = (...p) => path.resolve(__dirname, '..', ...p);
const ler = (rel) => fs.readFileSync(raiz(rel), 'utf8');

const NFCE = ler('src/main/nfce.js');
const APP = ler('src/renderer/app.js');
const PDV = ler('src/renderer/pages/pdv.js');
const COMPONENTS = ler('src/renderer/styles/components.js');
const MAIN = ler('src/main/main.js');
const PRELOAD = ler('src/main/preload.js');

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

/** Objetos vindos do `vm` tem outro prototipo; o que importa sao os campos. */
function conferir(real, esperado) {
  assert.deepEqual({ ...real }, esperado);
}

// ─── lerDesfechoDaEmissao ────────────────────────────────────────────────

function montarLeitor() {
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(`${extrair(NFCE, 'function lerDesfechoDaEmissao(r)')}
    module.fn = lerDesfechoDaEmissao;`, ctx);
  return ctx.module.fn;
}

describe('o desfecho que a tela recebe', () => {
  const ler = montarLeitor();

  test('autorizada: numero, serie e chave vem do servidor', () => {
    const d = ler({ ok: true, dados: { estado: 'autorizada', numero: '30025', serie: '1', chave: '3326...1250' } });
    conferir(d, { ok: true, estado: 'autorizada', jaEstava: false, numero: '30025', serie: '1', chave: '3326...1250' });
  });

  test('ja emitida nao e erro, e nao finge que acabou de emitir', () => {
    const d = ler({ ok: true, dados: { estado: 'ja_emitida', numero: '30012' } });
    assert.equal(d.ok, true);
    assert.equal(d.jaEstava, true);
  });

  // Tres recusas que nao sao problema do caixa, traduzidas antes da tela.
  test('terminal nao ativado diz o que fazer, nao "erro na emissao"', () => {
    const d = ler({ ok: false, motivo: 'sem_identidade', erro: 'Terminal não ativado' });
    assert.equal(d.ok, false);
    assert.match(d.erro, /ativado no painel/);
    assert.match(d.erro, /sistema web/);
  });

  test('rota ainda nao liberada para este terminal', () => {
    const d = ler({ ok: false, motivo: 'rota_desligada', erro: 'x' });
    assert.match(d.erro, /ainda não foi liberada/);
  });

  test('sem rede diz que a nota NAO saiu', () => {
    const d = ler({ ok: false, motivo: 'rede', erro: 'fetch failed' });
    assert.match(d.erro, /não saiu/);
  });

  test('rejeicao da SEFAZ chega inteira, com o estado do servidor', () => {
    const d = ler({
      ok: false, motivo: 'recusado', status: 409,
      corpo: { estado: 'rejeitada', erro: 'Rejeição 865: Total dos pagamentos menor que o total da nota.' },
    });
    assert.equal(d.ok, false);
    assert.equal(d.estado, 'rejeitada');
    assert.match(d.erro, /Rejeição 865/);
  });

  test('resposta nenhuma nao vira sucesso', () => {
    const d = ler(null);
    assert.equal(d.ok, false);
    assert.equal(d.estado, 'sem_resposta');
  });
});

// ─── emitir ──────────────────────────────────────────────────────────────

/**
 * `emitir` rodando de verdade, com o banco local e o `chamarProtegida` que o
 * teste quiser. Devolve o registro das chamadas — e e assim que se prova que
 * venda nao sincronizada nem chega a sair do terminal.
 */
function montarEmitir({ vendaLocal = null, resposta = { ok: true, dados: { estado: 'autorizada', numero: '1' } }, falharEspelho = false } = {}) {
  const chamadas = { rotas: [], espelhos: [], avisos: [] };
  const ctx = {
    module: {},
    console: { warn: (...a) => chamadas.avisos.push(a.join(' ')) },
    terminal: {
      chamarProtegida: async (rota, corpo) => { chamadas.rotas.push({ rota, corpo }); return resposta; },
      chaveDe: (prefixo, conteudo) => `${prefixo}:hash(${conteudo})`,
    },
    db: {
      vendas: {
        getById: () => vendaLocal,
        atualizarNfce: (id, dados) => {
          if (falharEspelho) throw new Error('banco travado');
          chamadas.espelhos.push({ id, dados });
        },
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(`${extrair(NFCE, 'function idRemotoDe(id)')}
    ${extrair(NFCE, 'function lerDesfechoDaEmissao(r)')}
    ${extrair(NFCE, 'async function emitir(id, cpfCnpj)')}
    module.fn = emitir;`, ctx);
  return { emitir: ctx.module.fn, chamadas };
}

describe('pedir a nota ao servidor', () => {
  test('venda que ainda nao subiu NAO sai do terminal, e explica por que', async () => {
    const { emitir, chamadas } = montarEmitir({ vendaLocal: { id: 'local-1', remote_id: null } });
    const d = await emitir('local-1', null);
    assert.equal(d.ok, false);
    assert.equal(d.estado, 'venda_nao_subiu');
    assert.match(d.erro, /ainda não foi enviada/);
    assert.equal(chamadas.rotas.length, 0, 'nao deve chamar o servidor');
  });

  test('venda sincronizada vai pelo id REMOTO', async () => {
    const { emitir, chamadas } = montarEmitir({ vendaLocal: { id: 'local-1', remote_id: 'remoto-9' } });
    await emitir('local-1', '12345678909');
    assert.equal(chamadas.rotas.length, 1);
    assert.equal(chamadas.rotas[0].rota, '/api/pdv/nfce');
    assert.equal(chamadas.rotas[0].corpo.venda_id, 'remoto-9');
    assert.equal(chamadas.rotas[0].corpo.cpf_cnpj, '12345678909');
  });

  // A lista de Vendas de quem ve todos os terminais mostra vendas da NUVEM:
  // o id que ela tem em maos ja e o remoto, e nao existe no banco local.
  test('id que nao existe localmente e tratado como id da nuvem', async () => {
    const { emitir, chamadas } = montarEmitir({ vendaLocal: null });
    await emitir('remoto-da-nuvem', null);
    assert.equal(chamadas.rotas[0].corpo.venda_id, 'remoto-da-nuvem');
    assert.equal(chamadas.espelhos.length, 0, 'sem linha local, nada a espelhar');
  });

  test('sem CPF manda null — a nota sai de consumidor nao identificado', async () => {
    const { emitir, chamadas } = montarEmitir({ vendaLocal: { id: 'l', remote_id: 'r' } });
    await emitir('l', '');
    assert.equal(chamadas.rotas[0].corpo.cpf_cnpj, null);
  });

  test('a chave de idempotencia e a mesma para a mesma venda', async () => {
    const a = montarEmitir({ vendaLocal: { id: 'l', remote_id: 'r' } });
    await a.emitir('l', null);
    const b = montarEmitir({ vendaLocal: { id: 'l', remote_id: 'r' } });
    await b.emitir('l', '12345678909');
    assert.equal(a.chamadas.rotas[0].corpo.idempotency_key, b.chamadas.rotas[0].corpo.idempotency_key);
    assert.match(a.chamadas.rotas[0].corpo.idempotency_key, /^nfce:/);
  });

  test('nota autorizada e espelhada no banco local', async () => {
    const { emitir, chamadas } = montarEmitir({
      vendaLocal: { id: 'local-1', remote_id: 'remoto-9' },
      resposta: { ok: true, dados: { estado: 'autorizada', numero: '30025', serie: '1', chave: 'CH' } },
    });
    await emitir('local-1', null);
    assert.equal(chamadas.espelhos.length, 1);
    assert.equal(chamadas.espelhos[0].id, 'local-1');
    assert.equal(chamadas.espelhos[0].dados.numero, '30025');
    assert.equal(chamadas.espelhos[0].dados.referencia, 'remoto-9');
  });

  // A nota JA ESTA autorizada no servidor. Dizer que falhou porque o SQLite
  // local nao aceitou a escrita seria mentir sobre um documento fiscal.
  test('espelho local que falha NAO desfaz a nota', async () => {
    const { emitir, chamadas } = montarEmitir({
      vendaLocal: { id: 'l', remote_id: 'r' }, falharEspelho: true,
    });
    const d = await emitir('l', null);
    assert.equal(d.ok, true);
    assert.ok(chamadas.avisos.some(a => /espelho local falhou/.test(a)));
  });

  test('recusa do servidor nao escreve nada no banco local', async () => {
    const { emitir, chamadas } = montarEmitir({
      vendaLocal: { id: 'l', remote_id: 'r' },
      resposta: { ok: false, motivo: 'recusado', corpo: { estado: 'rejeitada', erro: 'Rejeição 778' } },
    });
    const d = await emitir('l', null);
    assert.equal(d.ok, false);
    assert.equal(chamadas.espelhos.length, 0);
  });
});

// ─── o documento do cliente ──────────────────────────────────────────────

describe('o CPF digitado no balcao', () => {
  const ctx = { module: {} };
  vm.createContext(ctx);
  vm.runInContext(`${extrair(APP, 'function conferirDocumentoDaNota(bruto)')}
    module.fn = conferirDocumentoDaNota;`, ctx);
  const conferirDoc = ctx.module.fn;

  test('em branco serve: e o caso mais comum', () => {
    for (const v of ['', '   ', null, undefined]) {
      const r = conferirDoc(v);
      assert.equal(r.ok, true, String(v));
      assert.equal(r.digitos, null);
    }
  });

  test('CPF e CNPJ saem limpos de mascara', () => {
    assert.equal(conferirDoc('123.456.789-09').digitos, '12345678909');
    assert.equal(conferirDoc('43.103.402/0001-24').digitos, '43103402000124');
  });

  // Pela metade NAO serve: emitir calado como nao identificado entregaria ao
  // cliente justamente a nota que ele pediu para nao receber.
  test('pela metade e recusa, e a mensagem diz quanto falta', () => {
    const r = conferirDoc('1234567');
    assert.equal(r.ok, false);
    assert.match(r.erro, /7 de 11/);
    assert.match(r.erro, /Apague tudo/);
  });
});

// ─── o botao no comprovante ──────────────────────────────────────────────

function montarBotao(politica, ultimaVenda) {
  const ctx = { module: {}, _politicaFiscal: politica, _ultimaVenda: ultimaVenda };
  vm.createContext(ctx);
  vm.runInContext(`${extrair(PDV, 'function _botaoDaNota()')}
    module.fn = _botaoDaNota;`, ctx);
  return ctx.module.fn();
}

describe('o botao [F] obedece a politica da loja', () => {
  const DESLIGADA = { emitir_no_balcao: false, pedir_documento: false, emitir_ao_fechar: false };
  const SOB_PEDIDO = { emitir_no_balcao: true, pedir_documento: true, emitir_ao_fechar: false };

  test('loja que nao emite pelo caixa nao ganha botao', () => {
    assert.equal(montarBotao(DESLIGADA, { numero: 1, venda: {} }), '');
  });

  test('loja que emite mostra "Emitir NFC-e"', () => {
    const html = montarBotao(SOB_PEDIDO, { numero: 1, venda: {} });
    assert.match(html, /Emitir NFC-e/);
    assert.match(html, /btn-comprovante-nfce/);
  });

  // Apertar [F] duas vezes nao pode virar duas notas.
  test('venda com nota troca emitir por reimprimir, com o numero na tela', () => {
    const html = montarBotao(SOB_PEDIDO, { numero: 1, venda: {}, nfce: { numero: '30025', chave: 'CH' } });
    assert.match(html, /Reimprimir NFC-e 30025/);
    assert.doesNotMatch(html, /Emitir NFC-e/);
  });

  // Mesmo com a politica desligada: a nota existe e reimprimir nao emite nada.
  test('nota ja emitida continua reimprimivel se a politica for desligada depois', () => {
    const html = montarBotao(DESLIGADA, { numero: 1, venda: {}, nfce: { numero: '30025' } });
    assert.match(html, /Reimprimir NFC-e 30025/);
  });
});

// ─── o caminho antigo nao existe mais ────────────────────────────────────

describe('o terminal nao conhece credencial fiscal', () => {
  test('focusnfe.js foi removido', () => {
    assert.equal(fs.existsSync(raiz('src/main/focusnfe.js')), false);
  });

  test('nenhum fonte le token nem ambiente fiscal do store', () => {
    for (const [nome, fonte] of [['main', MAIN], ['components', COMPONENTS], ['pdv', PDV], ['app', APP], ['nfce', NFCE]]) {
      assert.doesNotMatch(fonte, /config\.fiscal_token/, nome);
      assert.doesNotMatch(fonte, /fiscal_token_producao/, nome);
    }
  });

  test('a tela de configuracoes nao tem mais campo de token', () => {
    assert.doesNotMatch(COMPONENTS, /id="cfg-fiscal-token"/);
    assert.doesNotMatch(COMPONENTS, /Config\.testarFiscal\(\)/);
    assert.doesNotMatch(COMPONENTS, /Config\.salvarFiscal\(\)/);
  });

  test('nenhum endereco de provedor fiscal no codigo do terminal', () => {
    for (const fonte of [MAIN, NFCE, COMPONENTS, PDV, APP]) {
      assert.doesNotMatch(fonte, /focusnfe\.com\.br/);
      assert.doesNotMatch(fonte, /brasilnfe/i);
    }
  });

  test('a superficie do preload tem so as tres chamadas novas', () => {
    assert.match(PRELOAD, /emitir:\s+\(id, cpfCnpj\)/);
    assert.match(PRELOAD, /cupom:\s+\(id\)/);
    assert.match(PRELOAD, /politica:\s+\(\)/);
    assert.doesNotMatch(PRELOAD, /nfce:consultar|nfce:cancelar|nfce:registrarBase44/);
  });

  test('o renderer nao chama mais consultar/cancelar/registrarBase44', () => {
    for (const fonte of [PDV, COMPONENTS, APP]) {
      assert.doesNotMatch(fonte, /nfce\.consultar|nfce\.cancelar|nfce\.registrarBase44/);
    }
  });
});

// ─── a politica desce pelo sincronismo ───────────────────────────────────

const SYNC = ler('src/main/sync.js');

describe('a politica chega ao terminal pelo sync', () => {
  test('a descida esta na sequencia do syncNow', () => {
    const inicio = SYNC.indexOf('await syncDownClientesMesclados();');
    const fim = SYNC.indexOf("store.set('sync.ultima_sync'");
    assert.ok(inicio > 0 && fim > inicio);
    assert.match(SYNC.slice(inicio, fim), /await syncDownPoliticaFiscal\(\);/);
  });

  function montarDescida(politicaDoServidor) {
    const guardado = {};
    const ctx = {
      module: {},
      console: { log() {}, warn() {} },
      store: { get: (k) => guardado[k], set: (k, v) => { guardado[k] = v; } },
      require: () => ({ politica: async () => politicaDoServidor }),
    };
    vm.createContext(ctx);
    vm.runInContext(`${extrair(SYNC, 'async function syncDownPoliticaFiscal()')}
      module.fn = syncDownPoliticaFiscal;`, ctx);
    return { rodar: ctx.module.fn, guardado };
  }

  test('guarda a politica que o servidor mandou', async () => {
    const { rodar, guardado } = montarDescida({
      emissao_balcao: 'sob_pedido', emitir_no_balcao: true, emitir_ao_fechar: false, pedir_documento: true,
    });
    await rodar();
    assert.equal(guardado.config_fiscal.emissao_balcao, 'sob_pedido');
    assert.equal(guardado.config_fiscal.pedir_documento, true);
  });

  // Mesma regra da mensagem do cupom: nao deu para perguntar nao e "a loja
  // desligou". Apagar a politica porque a rede caiu tiraria o botao do caixa
  // no meio do expediente.
  test('sem resposta mantem a politica que ja estava guardada', async () => {
    const { rodar, guardado } = montarDescida(undefined);
    guardado.config_fiscal = { emissao_balcao: 'sob_pedido' };
    await rodar();
    assert.equal(guardado.config_fiscal.emissao_balcao, 'sob_pedido');
  });
});

describe('as duas telas usam a mesma decisao', () => {
  test('emitir e imprimir nota moram em app.js, uma vez', () => {
    assert.equal((APP.match(/async function emitirNotaDaVenda/g) || []).length, 1);
    assert.equal((APP.match(/async function imprimirNotaDaVenda/g) || []).length, 1);
    // E as telas chamam, em vez de reimplementar.
    assert.match(PDV, /await emitirNotaDaVenda\(uv\.id, cpfCnpj\)/);
    assert.match(COMPONENTS, /await emitirNotaDaVenda\(id, cpfCnpj\)/);
  });

  test('o cupom da nota vai pela mesma porta do resto da impressao', () => {
    assert.match(APP, /imprimirCupom\(\{ _html: c\.html \}\)/);
  });

  // O handler antigo so se auto-removia no proximo keydown; com o comprovante
  // sendo redesenhado no meio da vida, dois handlers vivos fariam um [F]
  // virar dois cliques.
  test('os atalhos do comprovante nao se acumulam ao redesenhar', () => {
    const fn = extrair(PDV, 'function _setupComprovanteKeys()');
    assert.match(fn, /^\s*function _setupComprovanteKeys\(\) \{\s*\n\s*_desligarComprovanteKeys\(\);/);
    assert.match(PDV, /function _desligarComprovanteKeys\(\)/);
  });

  test('a emissao automatica nao bloqueia o fechamento da venda', () => {
    // Sem `await`: a nota e efeito da venda, nao passo dela.
    assert.match(PDV, /\n      _emitirAoFechar\(\);/);
    assert.doesNotMatch(PDV, /await _emitirAoFechar\(\)/);
  });

  test('politica ausente nunca faz nota sair sozinha', () => {
    const fn = extrair(MAIN, "ipcMain.handle('nfce:politica'");
    assert.match(fn, /emissao_balcao: 'desligado'/);
    assert.match(fn, /emitir_ao_fechar: false/);
    // E no renderer o padrao e o mesmo.
    assert.match(PDV, /let _politicaFiscal = \{ emissao_balcao: 'desligado'/);
  });
});

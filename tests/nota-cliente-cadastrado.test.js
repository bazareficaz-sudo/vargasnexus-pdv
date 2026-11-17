const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// IDENTIFICAR A NOTA PELO CADASTRO, E NAO SO PELO CPF.
//
// O relato de 16/11/2026: o cliente comprou com um vendedor, nao disse nada a
// ele, e so no caixa pediu a nota no nome do cadastro que ja tem na loja.
//
// O modal do balcao aceitava um numero e mais nada. Isso resolve METADE: a
// nota sai no CPF, que e o que identifica o comprador na NFC-e, mas sai sem
// nome e -- o que importa para a loja -- a venda continua sem dono. A compra
// nao entra na ficha de ninguem.
//
// Agora o modal busca o cadastro no banco DESTA maquina (sem ida a rede com
// cliente esperando) e manda o id da nuvem junto com a emissao. Quem decide
// se esse id existe, e se e desta loja, e o servidor.

const raiz = (...p) => path.resolve(__dirname, '..', ...p);
const APP = fs.readFileSync(raiz('src/renderer/app.js'), 'utf8');
const NFCE = fs.readFileSync(raiz('src/main/nfce.js'), 'utf8');
const PRELOAD = fs.readFileSync(raiz('src/main/preload.js'), 'utf8');
const PDV = fs.readFileSync(raiz('src/renderer/pages/pdv.js'), 'utf8');
const COMPONENTS = fs.readFileSync(raiz('src/renderer/styles/components.js'), 'utf8');

/** Recorta um trecho do fonte contando chaves a partir do corpo. */
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

/** Um DOM de mentira: so o que o modal toca. */
function domFalso() {
  const nos = new Map();
  const criar = (id) => {
    const no = {
      id, value: '', innerHTML: '', textContent: '',
      focado: false,
      focus() { this.focado = true; },
      querySelectorAll: () => [],
    };
    nos.set(id, no);
    return no;
  };
  return {
    nos,
    document: {
      getElementById: (id) => nos.get(id) || criar(id),
      querySelector: (sel) => {
        // O unico seletor que o codigo usa: o primeiro resultado da busca.
        if (sel !== '#nota-cliente-lista [data-cli]') return null;
        const lista = nos.get('nota-cliente-lista');
        if (!lista || !/data-cli=/.test(lista.innerHTML)) return null;
        return { click: () => { lista.clicouNoPrimeiro = true; } };
      },
    },
  };
}

/** Monta `NotaCliente` + a leitura do modal num contexto isolado. */
function montar({ clientes = [] } = {}) {
  const dom = domFalso();
  const ctx = {
    window: { pdv: { clientes: { buscar: async () => clientes } } },
    document: dom.document,
    console: { warn() {}, error() {} },
    setTimeout, clearTimeout,
    JSON, encodeURIComponent, decodeURIComponent, String,
    module: {},
  };
  vm.createContext(ctx);
  vm.runInContext([
    extrair(APP, 'function conferirDocumentoDaNota('),
    'let _clienteDaNota = null;',
    extrair(APP, 'const NotaCliente = {').replace(/^const NotaCliente = /, 'const NotaCliente = ') + ';',
    extrair(APP, 'function documentoInformadoNaTela('),
    'module.api = { NotaCliente, documentoInformadoNaTela };',
  ].join('\n'), ctx);
  return { ...ctx.module.api, dom };
}

const CLIENTE = {
  id: 'local-7', remote_id: 'b7f1c2d3-4e5f-4a6b-8c9d-0e1f2a3b4c5d',
  nome: 'MARIA DE SOUZA', cpf_cnpj: '12345678909', telefone: '33999990000',
};

describe('o cadastro escolhido no modal', () => {
  test('sem escolher ninguem, o pedido sai so com o documento', () => {
    const api = montar();
    api.dom.nos.set('nota-doc', { id: 'nota-doc', value: '123.456.789-09', focus() {} });
    const r = api.documentoInformadoNaTela();
    assert.equal(r.digitos, '12345678909');
    assert.equal(r.clienteId, null, 'cliente nenhum nao pode virar id nenhum inventado');
  });

  test('escolher o cadastro manda o id DA NUVEM, nunca o local', () => {
    const api = montar();
    api.NotaCliente.escolher(encodeURIComponent(JSON.stringify({
      local: CLIENTE.id, remoto: CLIENTE.remote_id, nome: CLIENTE.nome, cpf: CLIENTE.cpf_cnpj,
    })));
    const r = api.documentoInformadoNaTela();
    assert.equal(r.clienteId, CLIENTE.remote_id);
    assert.notEqual(r.clienteId, CLIENTE.id);
  });

  test('escolher o cadastro preenche o CPF dele no campo', () => {
    const api = montar();
    const campo = { id: 'nota-doc', value: '', focus() {} };
    api.dom.nos.set('nota-doc', campo);
    api.NotaCliente.escolher(encodeURIComponent(JSON.stringify({
      local: 'x', remoto: 'u', nome: 'ALGUEM', cpf: '12345678909',
    })));
    assert.equal(campo.value, '12345678909');
  });

  // Cadastro feito no proprio terminal e ainda nao sincronizado nao tem id na
  // nuvem. Mandar o id local produziria recusa do servidor no meio do caixa.
  test('cadastro que ainda nao sincronizou nao vira cliente_id', () => {
    const api = montar();
    api.NotaCliente.escolher(encodeURIComponent(JSON.stringify({
      local: 'local-9', remoto: null, nome: 'NOVO', cpf: '12345678909',
    })));
    const r = api.documentoInformadoNaTela();
    assert.equal(r.clienteId, null);
    assert.equal(r.digitos, '12345678909', 'o CPF dele continua valendo');
  });

  test('tirar o cliente escolhido realmente tira', () => {
    const api = montar();
    api.NotaCliente.escolher(encodeURIComponent(JSON.stringify({
      local: 'x', remoto: 'u-1', nome: 'ALGUEM', cpf: '',
    })));
    assert.equal(api.NotaCliente.escolhido().remoto, 'u-1');
    api.NotaCliente.limpar();
    assert.equal(api.NotaCliente.escolhido(), null);
    assert.equal(api.documentoInformadoNaTela().clienteId, null);
  });

  // Reabrir o modal para OUTRA venda nao pode herdar o cliente da anterior --
  // seria pôr na nota de um cliente o nome de outro.
  test('montar o modal de novo zera o escolhido', () => {
    const api = montar();
    api.NotaCliente.escolher(encodeURIComponent(JSON.stringify({
      local: 'x', remoto: 'u-1', nome: 'ALGUEM', cpf: '',
    })));
    api.NotaCliente.reiniciar();
    assert.equal(api.NotaCliente.escolhido(), null);
  });

  test('documento pela metade continua sendo recusa, com ou sem cadastro', () => {
    const api = montar();
    api.dom.nos.set('nota-doc', { id: 'nota-doc', value: '123456', focus() {} });
    api.NotaCliente.escolher(encodeURIComponent(JSON.stringify({
      local: 'x', remoto: 'u-1', nome: 'ALGUEM', cpf: '',
    })));
    assert.equal(api.documentoInformadoNaTela(), null);
    assert.match(api.dom.nos.get('nota-doc-erro').textContent, /Faltam dígitos/);
  });
});

describe('a busca do modal', () => {
  test('menos de dois caracteres nao vai ao banco', async () => {
    let foi = 0;
    const api = montar();
    api.NotaCliente.aoDigitar('a');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(foi, 0);
    assert.equal(api.dom.nos.get('nota-cliente-lista')?.innerHTML ?? '', '');
  });

  test('o resultado vira botao com o id da nuvem embutido', async () => {
    const api = montar({ clientes: [CLIENTE] });
    api.NotaCliente.aoDigitar('maria');
    await new Promise(r => setTimeout(r, 320));
    const html = api.dom.nos.get('nota-cliente-lista').innerHTML;
    assert.match(html, /MARIA DE SOUZA/);
    assert.match(html, /data-cli="0"/);
    // Decodifica SO o payload do onclick: o resto do HTML tem `%` de CSS
    // ("width:100%"), que nao e escape de URI.
    const m = html.match(/NotaCliente\.escolher\('([^']+)'\)/);
    assert.ok(m, 'o botao precisa chamar escolher com os dados embutidos');
    const dados = JSON.parse(decodeURIComponent(m[1]));
    assert.equal(dados.remoto, CLIENTE.remote_id);
    assert.equal(dados.local, CLIENTE.id);
  });

  test('mostra no maximo seis, para a lista nao engolir o modal', async () => {
    const muitos = Array.from({ length: 20 }, (_, i) => ({ ...CLIENTE, id: `l${i}`, nome: `CLIENTE ${i}` }));
    const api = montar({ clientes: muitos });
    api.NotaCliente.aoDigitar('cliente');
    await new Promise(r => setTimeout(r, 320));
    const html = api.dom.nos.get('nota-cliente-lista').innerHTML;
    assert.equal((html.match(/data-cli=/g) || []).length, 6);
  });

  test('Enter na busca escolhe o primeiro, em vez de emitir sem ninguem', async () => {
    const api = montar({ clientes: [CLIENTE] });
    api.NotaCliente.aoDigitar('maria');
    await new Promise(r => setTimeout(r, 320));
    let impediu = false;
    const usou = api.NotaCliente.aoTeclar({ key: 'Enter', preventDefault: () => { impediu = true; } });
    assert.equal(usou, true);
    assert.equal(impediu, true, 'sem preventDefault o Enter vazaria para o botao de emitir');
    assert.equal(api.dom.nos.get('nota-cliente-lista').clicouNoPrimeiro, true);
  });

  test('outra tecla passa direto', () => {
    const api = montar();
    assert.equal(api.NotaCliente.aoTeclar({ key: 'a', preventDefault() {} }), false);
  });
});

describe('o caminho do id ate a rota', () => {
  test('o modal tem o campo de busca e o de documento, nessa ordem', () => {
    const html = extrair(APP, 'function htmlDocumentoDaNota(');
    const busca = html.indexOf('nota-cliente-busca');
    const doc = html.indexOf('nota-doc');
    assert.ok(busca > 0 && doc > 0);
    assert.ok(busca < doc, 'o cadastro resolve mais do que o CPF, entao vem primeiro');
  });

  test('`nfce.emitir` manda `cliente_id` no corpo', () => {
    const fn = extrair(NFCE, 'async function emitir(id, cpfCnpj, clienteId)');
    assert.match(fn, /cliente_id: clienteId \|\| null/);
    assert.match(fn, /cpf_cnpj: cpfCnpj \|\| null/, 'o CPF continua indo junto');
  });

  test('a ponte do preload carrega os tres argumentos', () => {
    assert.match(PRELOAD, /emitir: *\(id, cpfCnpj, clienteId\) => ipcRenderer\.invoke\('nfce:emitir', id, cpfCnpj, clienteId\)/);
  });

  // As duas telas que emitem precisam passar o cliente adiante. Uma delas
  // esquecendo e o defeito silencioso: o operador escolhe, a nota sai sem
  // nome, e nada reclama.
  test('as duas telas repassam o cliente escolhido', () => {
    assert.match(PDV, /_emitirEImprimirNota\(informado\.digitos, informado\.clienteId\)/);
    assert.match(PDV, /async function _emitirEImprimirNota\(cpfCnpj, clienteId\)/);
    assert.match(COMPONENTS, /_emitirEImprimirNota\(id, informado\.digitos, informado\.clienteId\)/);
    assert.match(COMPONENTS, /async _emitirEImprimirNota\(id, cpfCnpj, clienteId\)/);
  });

  test('o helper comum repassa para o main', () => {
    const fn = extrair(APP, 'async function emitirNotaDaVenda(');
    assert.match(fn, /window\.pdv\.nfce\.emitir\(id, cpfCnpj, clienteId \|\| null\)/);
  });
});

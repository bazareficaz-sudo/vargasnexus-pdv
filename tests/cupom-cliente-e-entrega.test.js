const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');

// O CLIENTE E O ENDERECO NO CUPOM DE VENDA.
//
// Duas reclamacoes do balcao, e so uma delas era o que parecia.
//
// 1. "O cliente nao vem no cupom." Vinha — numa linha de 8pt centralizada no
//    meio do cabecalho, entre o numero da venda e o nome do vendedor, do
//    mesmo tamanho dos dois. Um nome longo como "ESCRITORIO CONTABILIDADE
//    ROCHA RANGEL" quebrava em duas linhas minusculas e sumia. O dado estava
//    la; o cupom e que nao mostrava.
//
// 2. "Venda com entrega nao traz endereco nem nome." Essa era real, e por
//    inteiro: `gerarHtmlCupom` nunca conheceu entrega. O endereco so existia
//    no `gerarHtmlCupomEntrega`, outro documento, impresso por outro botao
//    dentro do modal de entrega. Quem fechava a venda e mandava imprimir o
//    cupom recebia o cupom normal e ficava sem papel nenhum para mandar com a
//    mercadoria.
//
// O terceiro item nao e de conteudo e sim de papel: venda de um item so saia
// com uns quatro centimetros, curto demais para destacar e para o cliente
// guardar. Virou configuracao, com zero por padrao.

function carregarComStore(config) {
  const filename = path.resolve(__dirname, '../src/main/print-server.js');
  const req = Module.createRequire(filename);
  const mod = { exports: {} };
  const StoreFalso = class {
    get(chave) { return config[chave]; }
    set() {}
  };
  const mocks = {
    'electron-store': StoreFalso,
    electron: { app: { getPath: () => require('node:os').tmpdir(), isPackaged: false },
                BrowserWindow: class {}, ipcMain: { handle() {}, on() {} } },
  };
  const exec = vm.runInThisContext(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename });
  exec(mod.exports, n => Object.hasOwn(mocks, n) ? mocks[n] : req(n), mod, filename, path.dirname(filename));
  return mod.exports;
}

const VENDA = {
  numero: 304591,
  empresa_nome: 'Bazar Eficaz',
  vendedor_nome: 'Flavio',
  itens: [{ produto_nome: 'FITA ISOLANTE 3M - 5 METROS', quantidade: 1, preco_unitario: 7, subtotal: 7 }],
  subtotal: 7, desconto: 0, total: 7,
  forma_pagamento: 'pix', valor_pago: 7, troco: 0,
  created_at: '2026-11-15T11:21:45Z',
};

const ENDERECO = {
  cliente_telefone: '(21) 99817-0077',
  logradouro: 'Rua Santana', numero: '455', complemento: 'Fundos', bairro: 'Centro',
  cidade: 'Nova Iguacu', estado: 'RJ', cep: '26255-170',
  referencia: 'Portao verde, ao lado da padaria',
  data_agendada: '2026-11-17', turno: 'tarde',
  observacao: 'Ligar 10 min antes',
};

function cupom(dados, config = {}) {
  return carregarComStore(config).gerarHtmlCupom({ ...VENDA, ...dados });
}

describe('o cliente no cupom', () => {
  test('aparece com rotulo proprio, e nao mais perdido no cabecalho', () => {
    const html = cupom({ cliente_nome: 'ESCRITORIO CONTABILIDADE ROCHA RANGEL' });
    assert.match(html, /class="rotulo">Cliente</);
    assert.match(html, /ESCRITORIO CONTABILIDADE ROCHA RANGEL/);
  });

  test('o nome sai em negrito, no tamanho do corpo -- nao no tamanho da data', () => {
    // A linha antiga era `center sm`: a MENOR fonte do cupom, a mesma do
    // numero da venda. O nome do cliente nao e nota de rodape.
    const html = cupom({ cliente_nome: 'NELSON ROQUE' });
    assert.ok(!html.includes('<div class="center sm">Cliente:'), 'voltou para o cabecalho');
    assert.match(html, /<div class="bold">NELSON ROQUE<\/div>/);
  });

  test('venda sem cliente nao ganha bloco vazio', () => {
    const html = cupom({});
    assert.ok(!html.includes('>Cliente<'), html.slice(0, 400));
  });

  test('nome com caractere de HTML nao quebra o cupom', () => {
    // "A & B <LTDA>" entrava cru no HTML. Um `<` perdido engolia o resto do
    // cupom na renderizacao -- e o cupom e o unico comprovante do cliente.
    const html = cupom({ cliente_nome: 'A & B <LTDA>' });
    assert.match(html, /A &amp; B &lt;LTDA&gt;/);
    assert.ok(!html.includes('<LTDA>'));
  });

  test('o nome do produto tambem e escapado', () => {
    const html = cupom({ itens: [{ produto_nome: 'CABO 2,5MM <AZUL>', quantidade: 1, preco_unitario: 3, subtotal: 3 }] });
    assert.match(html, /CABO 2,5MM &lt;AZUL&gt;/);
  });
});

describe('o endereco de entrega no cupom', () => {
  test('o endereco inteiro entra no cupom da venda', () => {
    const html = cupom({ cliente_nome: 'JOAO', entrega: ENDERECO });
    assert.match(html, /ENTREGAR EM|Entregar em/i);
    assert.match(html, /Rua Santana, 455/);
    assert.match(html, /Fundos - Centro/);
    assert.match(html, /Nova Iguacu - RJ - 26255-170/);
  });

  test('telefone, referencia e observacao vao junto', () => {
    const html = cupom({ entrega: ENDERECO });
    assert.match(html, /\(21\) 99817-0077/);
    assert.match(html, /Portao verde/);
    assert.match(html, /Ligar 10 min antes/);
  });

  test('a data sai em dd/mm e o turno por extenso', () => {
    // `2026-11-17` sem hora vira 16/11 em fuso negativo. O `T12:00:00` e o
    // que mantem a data que o operador digitou.
    const html = cupom({ entrega: ENDERECO });
    assert.match(html, /17\/11\/2026/);
    assert.match(html, /Tarde/);
  });

  test('venda sem entrega nao menciona entrega', () => {
    const html = cupom({ cliente_nome: 'JOAO' });
    assert.ok(!/entregar em/i.test(html), 'bloco de entrega apareceu sem entrega');
  });

  test('entrega sem nenhuma linha de endereco nao imprime bloco vazio', () => {
    // So telefone preenchido nao e endereco. Imprimir o titulo sozinho daria
    // a entender que o endereco existe e esta em branco.
    const html = cupom({ entrega: { cliente_telefone: '21999999999' } });
    assert.ok(!/entregar em/i.test(html));
  });

  test('endereco pela metade imprime o que tem', () => {
    // Endereco incompleto e comum no balcao, e meio endereco ainda entrega.
    const html = cupom({ entrega: { logradouro: 'Rua A', numero: '10' } });
    assert.match(html, /Rua A, 10/);
    assert.ok(!html.includes('undefined'));
    assert.ok(!html.includes('null'));
  });

  test('campo de entrega com HTML tambem e escapado', () => {
    const html = cupom({ entrega: { ...ENDERECO, logradouro: 'Rua <b>X</b>' } });
    assert.match(html, /Rua &lt;b&gt;X&lt;\/b&gt;/);
  });
});

describe('o papel extra no fim do cupom', () => {
  const contarBr = (html) => (html.match(/<br>/g) || []).length;

  test('sem configuracao, nada muda', () => {
    // Padrao neutro: quem nunca abriu a tela recebe o cupom do mesmo tamanho
    // de sempre.
    const base = contarBr(cupom({}));
    assert.equal(base, contarBr(cupom({}, { 'config.cupom_linhas_extras': 0 })));
  });

  test('configurado, alonga o cupom na medida pedida', () => {
    const base = contarBr(cupom({}));
    assert.equal(contarBr(cupom({}, { 'config.cupom_linhas_extras': 6 })), base + 6);
  });

  test('valor absurdo nao vira um metro de papel', () => {
    const base = contarBr(cupom({}));
    assert.equal(contarBr(cupom({}, { 'config.cupom_linhas_extras': 999 })), base + 12);
  });

  test('negativo e lixo valem zero', () => {
    const base = contarBr(cupom({}));
    for (const v of [-5, 'muito', null, undefined, NaN]) {
      assert.equal(contarBr(cupom({}, { 'config.cupom_linhas_extras': v })), base, String(v));
    }
  });
});

describe('o que nao podia mudar', () => {
  test('o cupom continua trazendo itens, total e pagamento', () => {
    const html = cupom({ cliente_nome: 'JOAO', entrega: ENDERECO });
    assert.match(html, /FITA ISOLANTE 3M - 5 METROS/);
    assert.match(html, /TOTAL/);
    assert.match(html, /R\$ 7,00/);
    assert.match(html, /PIX/);
  });

  test('o vendedor continua no cabecalho', () => {
    assert.match(cupom({}), /Vendedor: Flavio/);
  });

  test('o comprovante de entrega separado continua existindo', () => {
    // Ele tem as duas assinaturas, do entregador e do cliente. O bloco novo
    // no cupom nao substitui essa via.
    const ps = carregarComStore({});
    assert.equal(typeof ps.gerarHtmlCupomEntrega, 'function');
    const html = ps.gerarHtmlCupomEntrega({ ...ENDERECO, cliente_nome: 'JOAO', itens: [] });
    assert.match(html, /COMPROVANTE DE ENTREGA/);
    assert.match(html, /Assinatura do Entregador/);
  });
});

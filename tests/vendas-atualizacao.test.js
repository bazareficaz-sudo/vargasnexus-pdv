const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A TELA DE VENDAS DO CAIXA.
//
// Ela e lida o dia inteiro por quem esta atendendo, e por isso tem tres
// armadilhas que ja custaram caro uma vez: o checkbox que era, na verdade, o
// unico jeito de atualizar; a selecao que sumia; e a tela que piscava.
//
// Nao da para montar o DOM do Electron aqui, entao estes testes leem a fonte.
// E grosseiro de proposito: o que eles protegem e um contrato de comportamento
// que um refactor desatento desfaz sem perceber, e nesse caso a operadora
// descobre no balcao, com o cliente na frente.

const FONTE = fs.readFileSync(
  path.resolve(__dirname, '..', 'src/renderer/styles/components.js'), 'utf8');

/** O corpo do objeto `Vendas`, para os testes nao casarem com outra tela. */
const VENDAS = (() => {
  const ini = FONTE.indexOf('const Vendas = {');
  assert.ok(ini > 0, 'o objeto Vendas sumiu de components.js');
  const fim = FONTE.indexOf('\n};', ini);
  return FONTE.slice(ini, fim);
})();

describe('a fonte da lista e uma so', () => {
  test('o checkbox "Todos os terminais" nao existe mais', () => {
    // Ele lia o banco LOCAL quando desmarcado e o servidor quando marcado --
    // duas fontes atras de um rotulo que nao dizia isso. E, sem botao de
    // atualizar, marcar e desmarcar virou o jeito de puxar venda nova.
    assert.doesNotMatch(FONTE, /_todoTerminais/);
    assert.doesNotMatch(FONTE, /venda-todos-terminais/);
  });

  test('quem nao pode ver todos os terminais continua vendo so o seu', () => {
    // Trocar a tela nao pode alargar permissao.
    assert.match(VENDAS, /ver_vendas_todos_terminais/);
  });
});

describe('a atualizacao e de verdade', () => {
  test('existe botao de atualizar', () => {
    assert.match(VENDAS, /atualizarAgora/);
    assert.match(FONTE, /vendas-btn-atualizar/);
  });

  test('existe tique automatico', () => {
    assert.match(VENDAS, /_ligarTimer/);
    assert.match(VENDAS, /setInterval/);
  });

  test('o tique se mata quando a tela sai do DOM', () => {
    // O app nao tem gancho de "saiu da tela". Sem esta guarda o intervalo
    // continuaria consultando o servidor para sempre, numa tela que ninguem ve.
    assert.match(VENDAS, /getElementById\('vendas-tbody'\)[\s\S]{0,120}clearInterval/);
  });

  test('so a data de hoje se atualiza sozinha', () => {
    assert.match(VENDAS, /toISOString\(\)\.split\('T'\)\[0\][\s\S]{0,80}return/);
  });
});

describe('as tres armadilhas da atualizacao silenciosa', () => {
  test('o tique nao limpa a selecao', () => {
    // Se limpasse, a operadora perderia as vendas marcadas para NFC-e a cada
    // 10 segundos -- e sem entender por que.
    assert.match(VENDAS, /if \(!silencioso\) \{[\s\S]{0,200}_sel = new Set\(\)/);
  });

  test('o tique nao pisca "Carregando"', () => {
    // Procura o HTML, nao a palavra: o comentario do proprio `load` cita
    // "Carregando..." para explicar a regra, e casar com ele faria o teste
    // passar (ou falhar) por causa de prosa.
    const load = VENDAS.slice(VENDAS.indexOf('async load('));
    const carregando = load.indexOf('>Carregando...<');
    const guarda = load.indexOf('if (!silencioso)');
    assert.ok(carregando > 0, 'o estado "Carregando..." sumiu da tela');
    assert.ok(guarda >= 0 && guarda < carregando,
      '"Carregando..." tem que estar dentro do ramo nao-silencioso');
  });

  test('nao repinta se a lista nao mudou', () => {
    // Redesenhar a tabela inteira a cada 10s faria o scroll pular na mao de
    // quem esta lendo.
    assert.match(VENDAS, /mudou[\s\S]{0,200}_renderTabela/);
  });
});

describe('a atualizacao automatica e escolha de quem opera', () => {
  test('existe o checkbox, e ele guarda a escolha na maquina', () => {
    assert.match(FONTE, /vendas-auto/);
    assert.match(VENDAS, /ligarAuto/);
    assert.match(VENDAS, /localStorage/);
  });

  test('o padrao e LIGADO', () => {
    // O caixa quer a lista viva; desligado por padrao devolveria o problema
    // que esta tela veio resolver.
    assert.match(VENDAS, /getItem\('vendas\.auto'\) !== 'nao'/);
  });

  test('ler a preferencia nao pode depender de rede nem estourar', () => {
    assert.match(VENDAS, /try \{ return localStorage[\s\S]{0,60}catch \{ return true; \}/);
  });

  test('desligado, o tique nao busca nada', () => {
    assert.match(VENDAS, /if \(!this\._lerAuto\(\)\) return;/);
  });
});

describe('sem rede, a lista nao some', () => {
  test('o erro carimba em vez de esvaziar', () => {
    // Um dia em branco por oscilacao de internet assusta mais do que ajuda.
    assert.match(VENDAS, /catch[\s\S]{0,200}_carimbar\(true\)/);
    assert.match(VENDAS, /if \(!this\._lista\.length\)/);
  });
});

describe('o que a tela passou a mostrar', () => {
  test('a coluna do vendedor', () => {
    assert.match(VENDAS, /<th>Vendedor<\/th>/);
    assert.match(VENDAS, /vendedor_nome/);
  });

  test('o terminal real, e nao "Este terminal"', () => {
    assert.doesNotMatch(VENDAS, /'Este terminal'/);
  });

  test('imprimir e editar so na venda que existe nesta maquina', () => {
    // Oferecer o botao numa venda de outro balcao seria prometer o que nao da
    // para cumprir: o registro nao esta no SQLite daqui.
    assert.match(VENDAS, /_locais/);
    assert.match(VENDAS, /const nuvem = !this\._locais\.has\(id\)/);
  });
});

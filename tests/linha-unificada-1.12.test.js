const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A 1.12.0 É A UNIFICACAO DAS DUAS LINHAS — E ESTE ARQUIVO SUBSTITUI O GUARDA.
//
// Ate aqui viviam duas linhagens de proposito:
//
//   1.10.9  PAGAMENTOS  — cliente transacional V1 (0.6D.3B), venda_pagamentos
//                         local, falar v2, e a parcela do cartao (4C.4)
//   1.11.x  LOJA        — compre junto, similares, orcamento com negociacao,
//                         rodape do cupom pelo servidor, consertos de impressao
//
// `linha-da-loja-sem-v1.test.js` guardava a separacao e cobrava que ela so
// fosse desfeita "junto com a decisao — nao antes, e nao calado". A decisao
// esta tomada, e o motivo dela fica aqui para nao se perder com o arquivo:
//
// POR QUE ESTAVAM SEPARADAS. O cliente V1 SEMPRE negocia: grava
// `negociando_v1` antes de enviar, qualquer que seja a flag. Erro de rede nao
// e recusa comprovada, entao venda feita offline e promovida a `v1` em
// definitivo — e com a flag DESLIGADA no servidor ela fica presa para sempre.
// Foi assim que 29 vendas ficaram retidas em 09/10/2026.
//
// POR QUE DA PARA UNIFICAR AGORA. Porque a instalacao e a flag passam a ser
// o MESMO passo, terminal por terminal: ninguem recebe a 1.12.0 com o V1
// desligado. Nao e o defeito que foi consertado — e o estado que o dispara
// que deixou de existir no procedimento.
//
// O QUE CONTINUA ABERTO, e nao entra nesta versao de proposito: promover a
// venda a `v1` por erro de rede e um defeito de verdade, e tem conserto
// proprio, com teste proprio. Misturar um conserto de protocolo com a
// unificacao faria a instalacao carregar duas coisas novas ao mesmo tempo,
// na via do dinheiro. Ele vem depois, sozinho.
//
// VOLTAR ATRAS NAO E DESLIGAR A FLAG. E reinstalar a 1.11.5, e so com a fila
// de sincronismo vazia: com venda pendente marcada `v1`, a 1.11.5 nao conhece
// o campo e mandaria tudo pelo legado — duplicata.

const raiz = path.resolve(__dirname, '..');
const existe = (p) => fs.existsSync(path.join(raiz, p));

function fontes(dir = path.join(raiz, 'src')) {
  const achados = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const cheio = path.join(dir, entrada.name);
    if (entrada.isDirectory()) achados.push(...fontes(cheio));
    else if (entrada.name.endsWith('.js')) achados.push(cheio);
  }
  return achados;
}

const ARQUIVOS = fontes();
const temNoFonte = (termo) =>
  ARQUIVOS.some(f => fs.readFileSync(f, 'utf8').includes(termo));

test('a varredura de fontes nao é vazia', () => {
  // Sem esta guarda, apagar `src/` faria todo o resto passar.
  assert.ok(ARQUIVOS.length > 15, `arquivos=${ARQUIVOS.length}`);
});

describe('o protocolo V1 chegou inteiro', () => {
  for (const modulo of ['src/main/protocoloVenda.js', 'src/main/payloadVendaV1.js',
                        'src/main/pagamentoVenda.js', 'src/renderer/lib/execucaoUnica.js']) {
    test(`${modulo} presente`, () => {
      assert.equal(existe(modulo), true, `${modulo} se perdeu na unificacao`);
    });
  }

  // Os mesmos nomes que o guarda proibia, agora exigidos: meio arquivo
  // sobrevivendo a um merge seria pior do que nenhum.
  for (const termo of ['negociando_v1', 'sync_payload_v1', 'sync_protocolo',
                       'venda_pagamentos', 'protocoloVenda', 'payloadVendaV1']) {
    test(`"${termo}" presente em src/`, () => {
      assert.ok(temNoFonte(termo), `"${termo}" nao chegou`);
    });
  }
});

describe('a parcela do cartao, que é o motivo da unificacao', () => {
  for (const [onde, marcador] of [
    ['a tela pergunta em quantas vezes', '_setParcelas'],
    ['o Misto pergunta por parte', 'misto-parcelas'],
    ['o banco local guarda', 'parcelas INTEGER NOT NULL DEFAULT 1'],
    ['o payload leva', 'parcelas: p.parcelas'],
  ]) {
    test(onde, () => assert.ok(temNoFonte(marcador), `marcador ausente: ${marcador}`));
  }

  test('a composicao v2 continua desligada por omissao', () => {
    // `podeV2` exige `ctx.pagamentosV2 === true`, e quem monta o payload em
    // `sync.js` nao passa esse campo. Desligado por omissao é mais seguro que
    // desligado por flag: nao existe lugar para ligar por engano.
    const sync = fs.readFileSync(path.join(raiz, 'src/main/sync.js'), 'utf8');
    assert.ok(!sync.includes('pagamentosV2'),
      'sync.js passou a ligar o v2 — isso é decisao separada, com a taxa conferida');
  });
});

describe('e a loja nao perdeu nada do que ja tinha', () => {
  const API = fs.readFileSync(path.join(raiz, 'src/main/api.js'), 'utf8');

  test('a correcao do recebimento duplicado da 1.10.6 continua', () => {
    // Perder isto seria devolver a loja a um defeito que ja custou
    // R$ 2.175,73 em lancamentos excedentes no historico.
    assert.match(API, /jaEstavaPago/);
  });

  for (const [recurso, marcador] of [
    ['Compre Junto', 'buscarCompreJunto'],
    ['Similares (consulta)', 'normalizarGrupoSimilar'],
    ['Similares (modal)', '_termoIdentificaMarca'],
    ['F12 mantem a lista', '_fecharFaltaPDV'],
    ['F8 limpa a tela', 'temAlgoALimpar'],
    ['rodape do cupom', 'mensagemDoCupom'],
    ['mensagem da empresa', 'cupom_mensagem_empresa'],
    ['origem da sugestao', 'origem_sugestao'],
    ['catalogo campos=v2', "campos: 'v2'"],
    // O caixa no terminal entrou DEPOIS da unificacao, e entra aqui pelo mesmo
    // motivo que o resto: um merge futuro nao pode largar a tela pelo caminho.
    ['caixa: a tela', 'Caixa.formSaida'],
    ['caixa: o telefone', 'caixaRemoto'],
    ['caixa: a ponte', "caixa:saida"],
  ]) {
    test(recurso, () => {
      assert.ok(temNoFonte(marcador), `marcador ausente: ${marcador}`);
    });
  }
});

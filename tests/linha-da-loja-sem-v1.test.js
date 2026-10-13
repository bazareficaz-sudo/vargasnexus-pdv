const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// A LINHA 1.11.x É A DA LOJA, E NAO TEM O CLIENTE V1.
//
// Existem duas linhagens vivas de propósito:
//
//   1.10.12  YOGA  — cliente transacional V1 (0.6D.3B) + as funcionalidades
//   1.11.x   LOJA  — so as funcionalidades, caminho de venda intocado
//
// POR QUE SEPARADAS. O cliente V1 SEMPRE negocia: toda venda nova grava
// `negociando_v1` antes de enviar, qualquer que seja a flag. Erro de rede nao
// e recusa comprovada, entao uma venda feita offline e promovida a `v1` em
// definitivo e, com a flag desligada, fica presa para sempre. Foi assim que
// 29 vendas ficaram retidas em 09/10/2026.
//
// Levar as funcionalidades novas aos cinco terminais da loja nao exige
// nenhum disso. Esta suite existe para que a separacao nao se desfaca por
// descuido num merge futuro: se o V1 voltar para ca sem decisao, estes testes
// falham e dizem o porque.
//
// Quando as duas linhas forem unificadas, este arquivo sai JUNTO com a
// decisao — nao antes, e nao calado.

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

describe('os modulos do protocolo V1 nao existem aqui', () => {
  test('a varredura de fontes nao é vazia', () => {
    // Sem esta guarda, apagar `src/` faria todo o resto passar.
    assert.ok(ARQUIVOS.length > 15, `arquivos=${ARQUIVOS.length}`);
  });

  for (const modulo of ['src/main/protocoloVenda.js', 'src/main/payloadVendaV1.js',
                        'src/main/pagamentoVenda.js', 'src/renderer/lib/execucaoUnica.js']) {
    test(`${modulo} ausente`, () => {
      assert.equal(existe(modulo), false,
        `${modulo} voltou para a linha da loja — o V1 nao entra aqui sem decisao`);
    });
  }
});

describe('nenhum vestigio do protocolo no codigo', () => {
  // Nomes que so existem no caminho transacional. Um deles aparecer significa
  // que o cliente V1 voltou — e o cliente V1 nao pode rodar sem a flag ligada
  // no servidor, terminal por terminal.
  const PROIBIDOS = ['negociando_v1', 'sync_payload_v1', 'sync_protocolo',
                     'completada_v2', 'conflito_pagamentos', 'venda_pagamentos',
                     'protocoloVenda', 'payloadVendaV1'];

  for (const termo of PROIBIDOS) {
    test(`"${termo}" nao aparece em src/`, () => {
      const culpados = ARQUIVOS
        .filter(f => fs.readFileSync(f, 'utf8').includes(termo))
        .map(f => path.relative(raiz, f));
      assert.deepEqual(culpados, [], `"${termo}" apareceu em: ${culpados.join(', ')}`);
    });
  }
});

describe('e a loja nao perde nada do que ja tinha', () => {
  const API = fs.readFileSync(path.join(raiz, 'src/main/api.js'), 'utf8');

  test('a correcao do recebimento duplicado da 1.10.6 continua', () => {
    // Era o unico delta da 1.10.6 sobre `main`. Perder isto aqui seria
    // devolver a loja a um defeito que ja custou R$ 2.175,73 em lancamentos
    // excedentes no historico.
    assert.match(API, /jaEstavaPago/);
  });

  test('a venda continua indo pelo caminho de sempre', () => {
    assert.match(API, /supabase\.from\('venda_itens'\)\.insert\(/);
  });
});

describe('mas as funcionalidades novas estao todas aqui', () => {
  const temNoFonte = (termo) =>
    ARQUIVOS.some(f => fs.readFileSync(f, 'utf8').includes(termo));

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
  ]) {
    test(recurso, () => {
      assert.ok(temNoFonte(marcador), `marcador ausente: ${marcador}`);
    });
  }
});

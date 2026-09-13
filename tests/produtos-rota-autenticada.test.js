const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// O CATÁLOGO SAI DE BAIXO DA CHAVE ANÔNIMA.
//
// MEDIDO EM 13/09/2026: 28.676 produtos legíveis com a chave `anon`, sem
// login nenhum, COM `preco_custo`. É a maior exposição das três tabelas
// auditadas — não é um id que vaza, é a margem da loja inteira.
//
// Por que esta etapa cabe agora, mesmo com a 0.6D pausada: o CAS de estoque
// escreve em UMA coluna de `produtos`, a `estoque`. Todo o resto que o PDV
// faz com a tabela é catálogo, e catálogo não depende do `registrarVenda`.
//
// Testes ESTRUTURAIS: estas funções falam com a rede em quase toda linha. O
// que fica travado é a PROPRIEDADE, não o retorno.

const RAIZ = path.join(__dirname, '..', 'src', 'main');

// O working tree deste repositório fica em CRLF no Windows; um marcador
// escrito com LF não casaria, e o teste mediria o formato do arquivo em vez
// do código.
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const api = fs.readFileSync(path.join(RAIZ, 'api.js'), 'utf8').split(CR + LF).join(LF);

function corpoDe(nome) {
  const inicio = api.indexOf('async function ' + nome + '(');
  assert.ok(inicio > 0, 'função ' + nome + ' não encontrada');
  const fim = api.indexOf(LF + '}' + LF, inicio);
  assert.ok(fim > inicio, 'não achei o fim de ' + nome);
  return api.slice(inicio, fim);
}

const MIGRADAS = ['sincronizarProdutos', 'contarProdutosRemoto', 'atualizarProduto'];

describe('a rota autenticada vem antes do Supabase', () => {
  for (const nome of MIGRADAS) {
    test(nome + ' tenta a rota primeiro', () => {
      const fn = corpoDe(nome);
      const rota = fn.indexOf('chamarProtegida');
      const supabase = fn.indexOf('supabase.from');
      assert.ok(rota > 0, nome + ' não chama a rota autenticada');
      // As três mantêm o legado no fim, como fallback de rollout. O que não
      // pode é o legado vir ANTES — aí a rota seria enfeite.
      assert.ok(rota < supabase, nome + ': o Supabase é consultado antes da rota');
    });

    test(nome + ': fallback só por sem_identidade + rota_desligada, e contado', () => {
      // Um timeout é AMBÍGUO: o servidor pode ter gravado e a resposta ter se
      // perdido. Cair no legado nesse caso é abrir a segunda escrita.
      const fn = corpoDe(nome);
      assert.match(fn, /rolloutNormal = \['sem_identidade', 'rota_desligada'\]/);
      assert.match(fn, /if \(!rolloutNormal\.includes\(r\.motivo\)\)/);
      assert.match(fn, /throw new Error/);
      // Duas formas, e a diferença importa: a escrita conta por entidade (uma
      // linha por produto), a leitura conta uma vez por dia — ela roda a cada
      // ciclo de sync, e reportar por ciclo seria requisição sem informação
      // nova, o dia inteiro, em todo terminal ainda não migrado.
      assert.match(fn, /registrarFallback\('produtos\.|_reportarFallbackDiario\('produtos\./);
    });
  }
});

describe('o saldo de estoque tem um escritor só', () => {
  test('ATUALIZARPRODUTO NUNCA MANDA ESTOQUE', () => {
    // `produtos.estoque` é movida pelo CAS de `_ajustarEstoqueCAS`, junto com
    // `produto_estoque.quantidade` e `estoque_movimentacoes`. Um segundo
    // caminho gravando a mesma coluna sem CAS, sem movimentação e sem espelho
    // no depósito é literalmente como nasceu a divergência de 13/09/2026 — a
    // que custou a reconciliação de 472 produtos.
    const fn = corpoDe('atualizarProduto');
    assert.ok(!/payload\.estoque/.test(fn), 'atualizarProduto voltou a mexer em estoque');
    assert.ok(!/payload\.estoque_minimo/.test(fn));
  });

  test('a edição tem chave estável pelo conteúdo', () => {
    // Uma UPDATE não tem id próprio. Mesmo conteúdo = mesma chave = replay
    // sem segunda escrita; campo editado = chave nova = atualização.
    assert.match(corpoDe('atualizarProduto'), /chaveDe\('produto'/);
  });
});

describe('a carga completa continua entrando lote a lote', () => {
  test('o caminho da rota preserva o onBatch', () => {
    // São 28.676 produtos. Sem o `onBatch`, a carga completa vira um array
    // único na memória do processo principal do Electron antes de chegar ao
    // SQLite — e o caminho novo não pode ser o que introduz isso.
    const fn = corpoDe('sincronizarProdutos');
    const rota = fn.indexOf('chamarProtegida');
    const trecho = fn.slice(rota);
    assert.match(trecho, /if \(onBatch\) onBatch\(/);
  });

  test('a paginação para pelo sinal do servidor', () => {
    assert.match(corpoDe('sincronizarProdutos'), /r\.dados\.tem_mais/);
  });
});

describe('o que NÃO foi migrado, e por quê', () => {
  test('GETPRODUTO FOI REMOVIDO, não migrado', () => {
    // Era `select('*')` por id — a linha inteira, `preco_custo` incluso. E
    // não tinha um único chamador.
    assert.ok(!/async function getProduto\(/.test(api));
    assert.ok(!/^\s{2}getProduto,$/m.test(api), 'ainda exportado');
  });

  test('o CAS de estoque continua no legado — é a 0.6D, e está pausada', () => {
    // Registrado aqui de propósito: depois desta etapa, o que sobra de
    // `produtos` sob `anon` é exatamente isto. Se um dia sumir daqui sem a
    // 0.6D ter acontecido, é porque alguém migrou o estoque sem o portão.
    const fn = corpoDe('_ajustarEstoqueCAS');
    assert.match(fn, /supabase\.from\('produtos'\)/);
    assert.ok(!/chamarProtegida/.test(fn), 'o estoque foi migrado sem a 0.6D');
  });
});

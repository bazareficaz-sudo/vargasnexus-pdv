const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// O PING NÃO PODE LER TABELA DE NEGÓCIO.
//
// Ele era `supabase.from('produtos').select('id', head)`. Funcionava, e por
// isso ninguém olhava — o custo não estava na consulta, estava em ela ser mais
// uma razão para a chave `anon` precisar continuar enxergando `produtos`.
//
// MEDIDO EM 13/09/2026: com a chave anônima, sem login nenhum, dá para ler
// 28.676 produtos COM `preco_custo`, 3.104 vendas e 103 clientes. São 21
// pontos do PDV presos a essas três tabelas; o ping era o único que não
// precisava de nenhum deles — não quer dado, quer saber se há caminho até o
// servidor.
//
// Estes testes são estruturais porque `ping` fala com a rede em toda linha. O
// que precisa ficar travado é a PROPRIEDADE: nenhuma tabela de negócio, e uma
// recusa do servidor contando como "online".

const RAIZ = path.join(__dirname, '..', 'src', 'main');

// Normaliza a quebra de linha antes de procurar qualquer coisa: o working
// tree deste repositório fica em CRLF no Windows, e um marcador de fim de
// função escrito com LF não casa com um arquivo em CRLF — o teste passaria a
// medir o formato do arquivo em vez do código.
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const ler = (arquivo) =>
  fs.readFileSync(path.join(RAIZ, arquivo), 'utf8').split(CR + LF).join(LF);

const api = ler('api.js');
const terminal = ler('terminal.js');

/** O corpo de uma função, do nome dela até a chave que a fecha na coluna 0. */
function corpoDe(fonte, nome) {
  const inicio = fonte.indexOf('async function ' + nome + '(');
  assert.ok(inicio > 0, 'função ' + nome + ' não encontrada');
  const fim = fonte.indexOf(LF + '}' + LF, inicio);
  assert.ok(fim > inicio, 'não achei o fim de ' + nome);
  return fonte.slice(inicio, fim);
}

describe('o ping não toca em tabela de negócio', () => {
  test('não lê produtos, vendas nem clientes', () => {
    const fn = corpoDe(api, 'ping');
    for (const tabela of ['produtos', 'vendas', 'clientes']) {
      assert.ok(!fn.includes("from('" + tabela + "')"), 'ping voltou a ler ' + tabela);
    }
  });

  test('não usa o cliente supabase de jeito nenhum', () => {
    // Qualquer `supabase.` aqui é uma chamada com a chave anon.
    assert.ok(!/supabase\./.test(corpoDe(api, 'ping')));
  });

  test('pergunta ao nosso servidor, pela rota autenticada', () => {
    assert.match(corpoDe(api, 'ping'), /servidorAlcancavel\(\)/);
    assert.match(corpoDe(terminal, 'servidorAlcancavel'), /\/api\/pdv\/heartbeat/);
  });
});

describe('o que conta como online', () => {
  const fn = corpoDe(terminal, 'servidorAlcancavel');

  test('RECUSA DO SERVIDOR É RESPOSTA DO SERVIDOR', () => {
    // Token vencido, rota desligada, terminal revogado: houve ida e volta pela
    // rede. Tratar isso como offline faria o PDV parar de sincronizar por uma
    // questão de permissão — e a fila inteira ficaria parada esperando uma
    // "conexão" que nunca esteve ausente.
    assert.match(fn, /r\.motivo !== 'rede'/);
  });

  test('falha de transporte é o único offline', () => {
    assert.match(fn, /catch \{[\s\S]{0,40}return false/);
  });

  test('SEM IDENTIDADE ainda responde — é o caso do terminal novo', () => {
    // Antes de ativar não há token, e `chamarProtegida` nem sairia para a
    // rede. O instalador precisa saber se há internet ANTES de pedir a
    // ativação, então qualquer status HTTP serve: o 401 é o servidor falando.
    assert.match(fn, /temIdentidade/);
    assert.match(fn, /typeof res\.status === 'number'/);
  });

  test('o heartbeat bem-sucedido também marca o terminal como vivo', () => {
    // Aproveita a ida: o painel passa a saber que o terminal está ligado sem
    // esperar a batida de 5 minutos.
    assert.match(fn, /ultimoHeartbeat = new Date/);
  });
});

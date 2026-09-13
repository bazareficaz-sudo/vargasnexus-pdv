const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// A TABELA COM CPF SAI DE BAIXO DA CHAVE ANÔNIMA.
//
// MEDIDO EM 13/09/2026: com a chave `anon`, sem login nenhum, dá para ler
// 28.676 produtos (com `preco_custo`), 3.104 vendas e 103 clientes — estes
// com `cpf_cnpj`. Das três, `clientes` é a única que dá para fechar por
// inteiro agora; `produtos` e `vendas` dependem do `registrarVenda`, que é a
// 0.6D e está pausada.
//
// Volume: 47 cadastros novos e 71 edições em 30 dias. Não é caminho quente, é
// caminho sensível.
//
// Estes testes são ESTRUTURAIS porque cada uma destas funções fala com a rede
// em quase toda linha. O que precisa ficar travado não é o retorno — é a
// PROPRIEDADE: a rota vem antes do Supabase, e cair no legado só acontece
// pelos dois motivos de rollout.

const RAIZ = path.join(__dirname, '..', 'src', 'main');

// O working tree deste repositório fica em CRLF no Windows; um marcador de
// fim de função escrito com LF não casaria, e o teste passaria a medir o
// formato do arquivo em vez do código.
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const api = fs.readFileSync(path.join(RAIZ, 'api.js'), 'utf8').split(CR + LF).join(LF);

/** O corpo de uma função, do nome dela até a chave que a fecha na coluna 0. */
function corpoDe(nome) {
  const inicio = api.indexOf('async function ' + nome + '(');
  assert.ok(inicio > 0, 'função ' + nome + ' não encontrada');
  const fim = api.indexOf(LF + '}' + LF, inicio);
  assert.ok(fim > inicio, 'não achei o fim de ' + nome);
  return api.slice(inicio, fim);
}

/** Onde a rota é chamada e onde o Supabase é usado, dentro da mesma função. */
function ordemDe(nome) {
  const fn = corpoDe(nome);
  return { rota: fn.indexOf('chamarProtegida'), supabase: fn.indexOf('supabase.from'), fn };
}

const ESCRITAS = ['registrarCliente', 'atualizarClienteEndereco'];
const LEITURAS = ['sincronizarClientes', 'sincronizarClientesMesclados'];

describe('a rota autenticada vem antes do Supabase', () => {
  for (const nome of [...ESCRITAS, ...LEITURAS]) {
    test(nome + ' tenta a rota primeiro', () => {
      const { rota, supabase } = ordemDe(nome);
      assert.ok(rota > 0, nome + ' não chama a rota autenticada');
      // `sincronizarClientesMesclados` e as escritas ainda têm o legado no
      // fim. O que não pode é o legado vir ANTES — aí a rota seria enfeite.
      if (supabase > 0) {
        assert.ok(rota < supabase, nome + ': o Supabase é consultado antes da rota');
      }
    });
  }
});

describe('cair no legado só pelos dois motivos de rollout', () => {
  // Esta é a regra que impede a migração de virar uma porta dos fundos: um
  // timeout é AMBÍGUO — o servidor pode ter gravado e a resposta ter se
  // perdido. Tentar o legado nesse caso abriria a segunda linha, que é
  // exatamente o que a rota existe para impedir. O certo é reenviar pela
  // MESMA rota com a MESMA chave, e isso é o retry da fila.
  for (const nome of [...ESCRITAS, ...LEITURAS]) {
    test(nome + ': lista de fallback é exatamente sem_identidade + rota_desligada', () => {
      const fn = corpoDe(nome);
      assert.match(fn, /rolloutNormal = \['sem_identidade', 'rota_desligada'\]/);
      assert.match(fn, /if \(!rolloutNormal\.includes\(r\.motivo\)\)/);
      assert.match(fn, /throw new Error/);
    });

    test(nome + ': o fallback é CONTADO, não silencioso', () => {
      // Sem isto, "fallback" é uma palavra num comentário. Com isto é uma
      // linha em `pdv_operacoes`, e é esse número que autoriza ou barra o
      // corte do `anon`.
      assert.match(corpoDe(nome), /registrarFallback\('clientes\./);
    });
  }
});

describe('o cadastro é idempotente pelo id que nasce em disco', () => {
  test('a chave é o id LOCAL do cliente', () => {
    // `db.clientes.criar()` gera esse uuid e grava no SQLite ANTES de
    // qualquer envio: sobrevive a queda, timeout, fechamento e reinício.
    assert.match(corpoDe('registrarCliente'), /idempotency_key: cliente\.id/);
  });

  test('a empresa vai no corpo para ser CONFERIDA', () => {
    // O servidor usa sempre a empresa do token. O campo vai junto para que um
    // terminal operando em outra empresa (`empresa_estoque_id`) receba recusa
    // explícita em vez de gravar cadastro na empresa errada.
    assert.match(corpoDe('registrarCliente'), /empresa_id: empresaId/);
  });

  test('a edição de endereço tem chave estável pelo conteúdo', () => {
    // Uma UPDATE não tem id próprio. Mesmo endereço = mesma chave = replay
    // sem segunda escrita; endereço editado = chave nova = atualização.
    assert.match(corpoDe('atualizarClienteEndereco'), /chaveDe\('cliente_end'/);
  });
});

describe('o que NÃO foi migrado, e por quê', () => {
  test('ATUALIZARCLIENTE GENÉRICO FOI REMOVIDO, não migrado', () => {
    // Era `update(dados)` com o objeto inteiro do chamador — `empresa_id`,
    // `mesclado_em`, `saldo_devedor`, `limite_credito` — numa tabela com CPF,
    // pela chave `anon`. E não tinha um único chamador.
    assert.ok(!/async function atualizarCliente\(/.test(api));
    assert.ok(!/^\s{2}atualizarCliente,$/m.test(api), 'ainda exportado');
  });

  test('unificação de estoque continua no legado, de propósito', () => {
    // Com `unificar_estoque` o legado NÃO filtra por empresa; a rota filtra
    // pela empresa do token. Usar a rota nesse caso entregaria menos gente do
    // que hoje, sem erro nenhum — só cadastros parando de receber
    // atualização. Enquanto não for decisão tomada, fica medido e no legado.
    for (const nome of LEITURAS) {
      assert.match(corpoDe(nome), /!usuario\.unificar_estoque/);
    }
  });
});

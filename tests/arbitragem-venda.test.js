const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const arb = require('../src/main/arbitragemVenda');

// FASE 0.6C.6A.1 — A ARBITRAGEM É PRECONDIÇÃO DA VENDA.
//
// O que se prova aqui é a DECISÃO, isolada: dado o que o servidor respondeu,
// esta venda sobe, perde, ou espera. Três desfechos, e confundir dois deles
// custa caro nos dois sentidos:
//
//   tratar indisponibilidade como conflito  → venda boa marcada como perdida,
//                                             e conflito não tem volta;
//   tratar conflito como transitório        → retry eterno, e em algum deles a
//                                             venda perdedora sobe.
//
// A prova de ponta a ponta — dois SQLite, dois processos, fila na ordem errada,
// restart — está no relatório da fase, feita contra o `database.js` e o
// `sync.js` reais. Aqui é a regra, sozinha.

const V = 'aaaaaaaa-1111-2222-3333-444444444444';
const OUTRA = 'bbbbbbbb-1111-2222-3333-444444444444';
const ORC_LOCAL = '0a0a0a0a-0b0b-0c0c-0d0d-0e0e0e0e0e0e';
const ORC_REMOTO = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

/** Uma venda nascida de orçamento, já com a identidade remota resolvida. */
const vendaDeOrcamento = (over = {}) => ({
  id: V, orcamento_id: ORC_LOCAL, orcamento_remote_id: ORC_REMOTO,
  orcamento_numero: 60, sync_status: 'pending', remote_id: null, ...over,
});

const ok = (estado, dados) => ({ tipo: 'ok', estado, dados: { estado, ...dados } });

describe('1. a identidade do orçamento que vai para o servidor', () => {
  test('id LOCAL != remote_id: quem vai é o remote_id', () => {
    // Medido no Escritório: 56 dos 58 documentos têm id == remote_id, e DOIS
    // não. O nº59 é `d87547a7…` local e `ee29e3b9…` remoto. Mandar o local
    // nesses dois faria a RPC responder `nao_encontrado` — e uma venda
    // legítima seria marcada como perdida por um id que nunca existiu lá.
    const v = vendaDeOrcamento();
    assert.notEqual(v.orcamento_id, v.orcamento_remote_id);
    assert.equal(arb.identidadeRemotaDoOrcamento(v), ORC_REMOTO);
  });

  test('NÚMERO NUNCA É IDENTIDADE', () => {
    // Guardrail explícito: nem como último recurso. O número é referência
    // comercial, o servidor o atribui e o cliente o estima — foi essa confusão
    // que duplicou orçamento na tela na 0.6C.2.
    const v = vendaDeOrcamento({ orcamento_remote_id: null, orcamento_numero: 60 });
    const r = arb.identidadeRemotaDoOrcamento(v);
    assert.equal(r, null);
    assert.notEqual(r, 60);
    assert.notEqual(r, '60');
  });

  test('orçamento que o servidor não conhece: ESPERA, não conflito', () => {
    // Criado offline e ainda não sincronizado. Não há documento remoto para
    // arbitrar, então não há confirmação possível — e a regra não abre
    // exceção: a venda não sobe. Mas também não perdeu nada: o próprio
    // orçamento está na fila à frente dela.
    const d = arb.decidirEnvio({ venda: vendaDeOrcamento({ orcamento_remote_id: null }), resultado: null });
    assert.equal(d.acao, 'esperar');
    assert.equal(d.motivo, 'orcamento_sem_identidade_remota');
  });

  test('venda sem orçamento não tem identidade a resolver', () => {
    assert.equal(arb.identidadeRemotaDoOrcamento({ id: V, orcamento_id: null }), null);
    assert.equal(arb.nasceuDeOrcamento({ id: V, orcamento_id: null }), false);
  });
});

describe('2. quando a venda pode subir', () => {
  test('convertido, e o vencedor é esta venda', () => {
    const d = arb.decidirEnvio({ venda: vendaDeOrcamento(), resultado: ok('convertido', { venda_id: V, revisao: 1 }) });
    assert.equal(d.acao, 'enviar');
    assert.equal(d.motivo, 'convertido');
  });

  test('ja_convertido pela MESMA venda também libera', () => {
    // É o retry. Se não fosse sucesso, a fila insistiria para sempre numa
    // operação que já aconteceu.
    const d = arb.decidirEnvio({ venda: vendaDeOrcamento(), resultado: ok('ja_convertido', { venda_id: V, revisao: 4 }) });
    assert.equal(d.acao, 'enviar');
  });

  test('VENDA COMUM passa direto, sem arbitrar nada', () => {
    const d = arb.decidirEnvio({ venda: { id: V, orcamento_id: null }, resultado: null });
    assert.equal(d.acao, 'enviar');
    assert.equal(d.motivo, 'sem_orcamento');
  });
});

describe('3. A CONFIRMAÇÃO É NOMINAL', () => {
  test('ja_convertido de OUTRA venda é conflito, não liberação', () => {
    // O caso que distingue "deu certo" de "é meu". Sem esta comparação, um
    // `ja_convertido` da venda do outro terminal liberaria a nossa.
    const d = arb.decidirEnvio({ venda: vendaDeOrcamento(), resultado: ok('ja_convertido', { venda_id: OUTRA }) });
    assert.equal(d.acao, 'conflito');
    assert.equal(d.vencedora, OUTRA);
  });

  test('sucesso sem dizer quem venceu não libera', () => {
    const d = arb.decidirEnvio({ venda: vendaDeOrcamento(), resultado: ok('convertido', {}) });
    assert.equal(d.acao, 'esperar');
    assert.equal(d.motivo, 'resposta_sem_vencedora');
  });

  test('estado de sucesso desconhecido não é interpretado', () => {
    const d = arb.decidirEnvio({ venda: vendaDeOrcamento(), resultado: ok('alguma_coisa_nova', { venda_id: V }) });
    assert.equal(d.acao, 'esperar');
    assert.match(d.motivo, /estado_inesperado/);
  });
});

describe('4. conflito é terminal', () => {
  test('conflito_conversao nomeia a vencedora', () => {
    const d = arb.decidirEnvio({
      venda: vendaDeOrcamento(),
      resultado: { tipo: 'conflito_conversao', dados: { venda_vencedora_id: OUTRA, numero: 60, revisao: 1 } },
    });
    assert.equal(d.acao, 'conflito');
    assert.equal(d.estado, 'conflito_conversao');
    assert.equal(d.vencedora, OUTRA);
  });

  for (const estado of ['conflito_versao', 'recusado_cancelado', 'nao_encontrado']) {
    test(`${estado} também para o fluxo`, () => {
      const d = arb.decidirEnvio({ venda: vendaDeOrcamento(), resultado: { tipo: 'recusado', estado, dados: {} } });
      assert.equal(d.acao, 'conflito');
      assert.equal(d.estado, estado);
    });
  }
});

describe('5. o que NÃO é conflito', () => {
  test('erro de rede é espera', () => {
    const d = arb.decidirEnvio({ venda: vendaDeOrcamento(), resultado: { tipo: 'erro', motivo: 'rede' } });
    assert.equal(d.acao, 'esperar');
    assert.notEqual(d.acao, 'conflito');
  });

  test('ROTA DESLIGADA é espera, nunca conflito', () => {
    // Um rollout incompleto não pode marcar venda boa como perdida. A venda
    // não subiu, nada se perdeu, e ligar a flag resolve. Se isto virasse
    // conflito, um terminal sem a flag perderia vendas de verdade.
    for (const motivo of ['rota_desligada', 'sem_identidade']) {
      const d = arb.decidirEnvio({ venda: vendaDeOrcamento(), resultado: { tipo: 'legado', motivo } });
      assert.equal(d.acao, 'esperar');
      assert.match(d.motivo, /^rota_indisponivel/);
    }
  });

  test('resposta ausente é espera', () => {
    const d = arb.decidirEnvio({ venda: vendaDeOrcamento(), resultado: undefined });
    assert.equal(d.acao, 'esperar');
  });

  test('NENHUMA espera libera a venda', () => {
    const esperas = [
      { tipo: 'erro', motivo: 'rede' },
      { tipo: 'legado', motivo: 'rota_desligada' },
      undefined,
      ok('convertido', {}),
    ];
    for (const r of esperas) {
      assert.notEqual(arb.decidirEnvio({ venda: vendaDeOrcamento(), resultado: r }).acao, 'enviar');
    }
  });
});

describe('6. a perdedora não volta para a fila', () => {
  test('conflito_orcamento não é reenfileirável', () => {
    // `recuperarVendasPendentes` olhava só o status COMERCIAL. A perdedora tem
    // `remote_id` nulo para sempre — de propósito — então voltava para a fila
    // em todo ciclo.
    assert.equal(arb.podeReenfileirar({ id: V, sync_status: 'conflito_orcamento', remote_id: null }), false);
  });

  test('venda que só não subiu continua reenfileirável', () => {
    for (const s of ['pending', 'error', null, undefined]) {
      assert.equal(arb.podeReenfileirar({ id: V, sync_status: s, remote_id: null }), true, `sync_status=${s}`);
    }
  });
});

describe('7. O CÓDIGO QUE OBEDECE A REGRA', () => {
  const ler = (rel) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', rel), 'utf8');
  const sync = ler('sync.js');
  const api = ler('api.js');
  const database = ler('database.js');

  test('o portão vem ANTES de qualquer efeito remoto da venda', () => {
    const corpo = sync.slice(sync.indexOf('async function _sincronizarVendaCreate'));
    const fim = corpo.indexOf('\n}\n');
    const fn = corpo.slice(0, fim);
    const portao = fn.indexOf('_arbitrarAntesDeSubir');
    assert.ok(portao > 0, 'o portão está na função');
    // Nada que fale com o servidor pode aparecer antes dele — nem o cliente,
    // que também é efeito remoto derivado desta venda.
    for (const chamada of ['api.registrarVenda', 'api.registrarCliente']) {
      const onde = fn.indexOf(chamada);
      assert.ok(onde > portao, `${chamada} tem que vir DEPOIS do portão`);
    }
  });

  test('o retry manual entra pela mesma porta', () => {
    // `retentarVendaManual` chama `_sincronizarVendaCreate`, então herda o
    // portão. Se algum dia tiver caminho próprio, este teste cai.
    const fn = sync.slice(sync.indexOf('async function retentarVendaManual'));
    assert.match(fn.slice(0, 300), /_sincronizarVendaCreate/);
  });

  test('recuperarVendasPendentes exclui conflito_orcamento', () => {
    const fn = sync.slice(sync.indexOf('async function recuperarVendasPendentes'));
    assert.match(fn.slice(0, 1600), /sync_status.*!=\s*'conflito_orcamento'/s);
  });

  test('a fila entrega orçamento ANTES de venda', () => {
    const fn = database.slice(database.indexOf('getPendentes()'));
    const ordem = fn.slice(0, 1800);
    assert.ok(ordem.indexOf("entidade LIKE 'orcamento%'") < ordem.indexOf("entidade = 'venda'"),
      'orçamento tem que vir antes de venda na ordenação');
  });

  test('montarInsert manda a identidade REMOTA do orçamento', () => {
    assert.match(api, /orcamento_id:\s*venda\.orcamento_remote_id\s*\|\|\s*null/);
    // E nunca a local, que o servidor não conhece.
    assert.ok(!/orcamento_id:\s*venda\.orcamento_id\b/.test(api));
  });

  test('o guardrail do banco vira desfecho terminal, não retry', () => {
    assert.match(api, /arbitragem_orcamento:/);
    assert.match(api, /e\.arbitragem\s*=/);
    assert.match(sync, /if \(e\.arbitragem\)/);
  });

  test('getById resolve a identidade remota sem COALESCE para o id local', () => {
    const fn = database.slice(database.indexOf('o.remote_id as orcamento_remote_id') - 900);
    assert.match(fn, /o\.remote_id\s+as\s+orcamento_remote_id/);
    assert.ok(!/COALESCE\(o\.remote_id,\s*o\.id\)/.test(database),
      'COALESCE mandaria o id local como se fosse remoto');
  });
});

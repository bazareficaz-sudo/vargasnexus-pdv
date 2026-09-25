/**
 * FASE 4C.2 — composicao local de pagamentos de uma venda.
 *
 * Regras puras, sem banco e sem rede. A tabela `venda_pagamentos` é a
 * representacao local de "uma venda tem N pagamentos"; aqui mora a
 * aritmetica que decide o que pode virar linha.
 *
 * NADA AQUI FALA COM O SERVIDOR. O protocolo continua V1 — estrutura local
 * nova nao é protocolo novo ativado.
 */

'use strict';

// Formas individuais que um pagamento pode ter.
//
// `misto` e `multiplo` NAO estao aqui de proposito: eles descrevem a venda
// inteira, nao uma parcela. Transformar "misto" em forma de pagamento seria
// gravar a ausencia de informacao como se fosse informacao.
const FORMAS_CANONICAS = ['dinheiro', 'pix', 'credito', 'debito', 'credito_cliente', 'carteira'];

// O Electron diz `misto`; o PDV Web diz `multiplo`. Nao normalizamos o
// historico nesta fase — so reconhecemos os dois como agregacao.
const FORMAS_AGREGADAS = ['misto', 'multiplo'];

// Unica forma que move dinheiro fisico. Entregue e troco so existem nela.
const FORMAS_EM_ESPECIE = ['dinheiro'];

const ehCanonica = f => FORMAS_CANONICAS.includes(f);
const ehAgregada = f => FORMAS_AGREGADAS.includes(f);
const ehEspecie  = f => FORMAS_EM_ESPECIE.includes(f);

/**
 * Centavos inteiros.
 *
 * A 4C.1 encontrou `197.32000000000002` gravado em producao. O SQLite local
 * guarda REAL e nao vamos refatorar o banco inteiro nesta fase — mas
 * NENHUMA invariante monetaria daqui compara float cru.
 */
function centavos(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return NaN;
  const c = Math.round(n * 100);
  return Object.is(c, -0) ? 0 : c;
}

/** Soma em centavos e devolve em centavos — nunca acumula erro de float. */
function somarCentavos(lista) {
  return (lista || []).reduce((s, p) => s + centavos(p.valor), 0);
}

/**
 * A venda esta ESTRITAMENTE LOCAL?
 *
 * A 0.6D.3B persiste `negociando_v1` e o snapshot no MESMO UPDATE
 * condicional, ANTES de qualquer request sair da maquina. Portanto
 * `sync_protocolo IS NULL` é prova de que nenhuma tentativa existiu.
 *
 * Qualquer outro estado — negociando_v1, v1, legado, desconhecido, ou
 * remote_id preenchido — NAO prova ausencia de efeito remoto. `processado=0`
 * na fila tambem nao prova: o servidor pode ter commitado e a resposta ter
 * se perdido, que é exatamente o caso que a 0.6D.3B trata.
 *
 * Na duvida, preservar.
 */
function ehEstritamenteLocal(venda) {
  return venda != null && venda.sync_protocolo == null && !venda.remote_id;
}

/**
 * Valida UM pagamento ja normalizado.
 */
function validarPagamento(p, indice = 0) {
  const rotulo = `Pagamento ${indice + 1}`;

  if (!p || typeof p.forma !== 'string' || !ehCanonica(p.forma)) {
    if (p && ehAgregada(p && p.forma)) {
      return { ok: false, erro: `${rotulo}: "${p.forma}" descreve a venda, nao uma parcela.` };
    }
    return { ok: false, erro: `${rotulo}: forma nao reconhecida.` };
  }

  const c = centavos(p.valor);
  if (!Number.isFinite(c) || c <= 0) {
    return { ok: false, erro: `${rotulo}: valor deve ser maior que zero.` };
  }

  let entregue = null;
  let troco = null;

  if (p.valor_entregue != null && p.valor_entregue !== '') {
    if (!ehEspecie(p.forma)) {
      return { ok: false, erro: `${rotulo}: so pagamento em dinheiro tem valor entregue.` };
    }
    const ce = centavos(p.valor_entregue);
    if (!Number.isFinite(ce) || ce < c) {
      return { ok: false, erro: `${rotulo}: o valor entregue nao cobre o valor aplicado.` };
    }
    entregue = ce;
    troco = ce - c;
  }

  if (p.troco != null && p.troco !== '' && entregue === null) {
    return { ok: false, erro: `${rotulo}: troco exige o valor entregue.` };
  }
  if (p.troco != null && p.troco !== '' && centavos(p.troco) !== troco) {
    return { ok: false, erro: `${rotulo}: o troco nao confere com entregue menos aplicado.` };
  }

  const seq = p.sequencia == null || p.sequencia === '' ? indice + 1 : Number(p.sequencia);
  if (!Number.isInteger(seq) || seq <= 0) {
    return { ok: false, erro: `${rotulo}: sequencia invalida.` };
  }

  return {
    ok: true,
    valor: {
      forma: p.forma,
      valor: c / 100,
      valor_entregue: entregue === null ? null : entregue / 100,
      troco: troco === null ? null : troco / 100,
      sequencia: seq,
    },
  };
}

/**
 * Valida a composicao inteira contra o total da venda.
 *
 * A comparacao é em centavos inteiros. `47 + 100` nunca vira `147.00000001`
 * aqui porque nada é somado em float.
 */
function validarComposicao(lista, total) {
  if (!Array.isArray(lista) || lista.length === 0) {
    return { ok: false, erro: 'Informe ao menos um pagamento.' };
  }

  const validos = [];
  for (let i = 0; i < lista.length; i++) {
    const r = validarPagamento(lista[i], i);
    if (!r.ok) return r;
    validos.push(r.valor);
  }

  const soma = somarCentavos(validos);
  const alvo = centavos(total);
  if (soma !== alvo) {
    return {
      ok: false,
      erro: `A soma dos pagamentos (${(soma / 100).toFixed(2)}) nao fecha com o total da venda (${(alvo / 100).toFixed(2)}).`,
    };
  }

  return { ok: true, valor: validos };
}

/**
 * O ADAPTADOR da UI atual.
 *
 * A tela de hoje manda UMA forma. Derivamos dela um unico pagamento
 * normalizado — e so isso.
 *
 * Devolve [] (composicao ausente, que é o resultado CORRETO) quando:
 *  - a forma é `misto`/`multiplo` sem decomposicao real;
 *  - a forma é desconhecida;
 *  - nao ha forma;
 *  - o total nao é positivo (devolucao/troca nao é pagamento).
 *
 * Nunca divide valores, nunca assume dinheiro/cartao, nunca copia o total
 * como um pagamento "misto".
 *
 * `valor_entregue`/`troco` so saem quando a UI realmente os forneceu: hoje
 * `pdv.js` so abre o campo de troco para dinheiro.
 */
function comporDaVendaLocal({ forma_pagamento, total, valor_pago } = {}) {
  if (typeof forma_pagamento !== 'string' || !forma_pagamento) return [];
  if (ehAgregada(forma_pagamento)) return [];
  if (!ehCanonica(forma_pagamento)) return [];

  const c = centavos(total);
  if (!Number.isFinite(c) || c <= 0) return [];

  const pagamento = { forma: forma_pagamento, valor: c / 100, sequencia: 1 };

  if (ehEspecie(forma_pagamento) && valor_pago != null && valor_pago !== '') {
    const ce = centavos(valor_pago);
    if (Number.isFinite(ce) && ce >= c) {
      pagamento.valor_entregue = ce / 100;
      pagamento.troco = (ce - c) / 100;
    }
  }

  return [pagamento];
}

module.exports = {
  FORMAS_CANONICAS, FORMAS_AGREGADAS, FORMAS_EM_ESPECIE,
  ehCanonica, ehAgregada, ehEspecie,
  centavos, somarCentavos,
  ehEstritamenteLocal,
  validarPagamento, validarComposicao,
  comporDaVendaLocal,
};

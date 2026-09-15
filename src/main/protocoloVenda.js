/**
 * protocoloVenda.js — qual caminho a venda usa, e o que fazer com a resposta.
 *
 * FASE 0.6D.3. Regra pura, sem rede e sem banco, para poder ser testada
 * sozinha — mesmo padrão de `arbitragemVenda.js`.
 *
 * DUAS DECISÕES MORAM AQUI, e as duas são de segurança:
 *
 * 1. ESCOLHER O PROTOCOLO — uma vez só, antes do primeiro byte remoto.
 *
 *    A flag decide apenas VENDAS AINDA NÃO VINCULADAS. Uma venda que já
 *    escolheu `v1` continua `v1` para sempre, mesmo que a flag seja
 *    desligada depois. O motivo é concreto: se um retry relesse a flag, uma
 *    venda que já tentou o v1 — e pode ter commitado no servidor sem a
 *    resposta chegar — voltaria pelo legado. O legado não conhece
 *    `pdv_venda_sync`, mandaria tudo de novo, e aí sim nasceria a duplicata
 *    que esta fase inteira existe para impedir.
 *
 * 2. TRADUZIR A RESPOSTA — e nunca marcar `synced` no escuro.
 *
 *    Resposta ambígua (timeout, 5xx, rede) é `pendente`, não sucesso e não
 *    conflito: o estado remoto é desconhecido, e só o retry com o mesmo
 *    UUID pode desempatar. Chamar isso de erro terminal abandonaria uma
 *    venda que talvez esteja gravada; chamar de sucesso marcaria como
 *    completa uma que talvez não exista.
 */

'use strict';

/**
 * @param {object} venda  linha local (precisa de `sync_protocolo`)
 * @param {boolean} flagLigada  `rotas_habilitadas.vendas_transacional_v1`
 * @returns {'v1'|'legado'}
 */
function escolherProtocolo(venda, flagLigada) {
  // Já vinculada: a decisão anterior manda. Inclusive — e principalmente —
  // quando a flag mudou desde então.
  if (venda && venda.sync_protocolo === 'v1') return 'v1';
  if (venda && venda.sync_protocolo === 'legado') return 'legado';
  return flagLigada ? 'v1' : 'legado';
}

// Estados que a RPC devolve. Lidos do corpo da função em produção via
// `pg_get_functiondef` — não do relatório da 0.6D.2, que chamava um deles
// de `legado_inconsistente` quando o nome real é `legado_incompativel`.
const ESTADOS_SUCESSO = ['aplicada', 'ja_aplicada', 'completada_de_legado'];
const ESTADOS_TERMINAIS = ['conflito_payload', 'conflito_orcamento', 'legado_incompativel', 'payload_invalido'];

/**
 * @param {{ok?: boolean, estado?: string, erro?: string, httpStatus?: number}} resposta
 * @returns {{desfecho: 'synced'|'conflito'|'pendente', estado: string|null, telemetria: string, motivo?: string}}
 */
function interpretarResposta(resposta) {
  const estado = resposta && resposta.estado ? String(resposta.estado) : null;

  if (estado && ESTADOS_SUCESSO.includes(estado)) {
    return {
      desfecho: 'synced',
      estado,
      // `completada_de_legado` é sucesso, mas merece marca própria: é a
      // medida de quantas vendas estavam parciais no servidor.
      telemetria: estado === 'completada_de_legado'
        ? 'venda_sync_v1_completada_legado'
        : (estado === 'ja_aplicada' ? 'venda_sync_v1_ja_aplicada' : 'venda_sync_v1_aplicada'),
    };
  }

  if (estado && ESTADOS_TERMINAIS.includes(estado)) {
    return {
      desfecho: 'conflito',
      estado,
      telemetria: 'venda_sync_v1_conflito',
      motivo: resposta.motivo || estado,
    };
  }

  // Sem estado reconhecível: rede, timeout, 5xx, rota desligada, resposta
  // truncada. Estado remoto DESCONHECIDO — a venda fica pendente e o mesmo
  // UUID tenta de novo.
  return {
    desfecho: 'pendente',
    estado,
    telemetria: 'venda_sync_v1_erro',
    motivo: (resposta && (resposta.erro || resposta.motivo)) || 'resposta sem estado reconhecível',
  };
}

module.exports = { escolherProtocolo, interpretarResposta, ESTADOS_SUCESSO, ESTADOS_TERMINAIS };

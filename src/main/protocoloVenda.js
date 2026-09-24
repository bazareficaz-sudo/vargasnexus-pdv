/**
 * FASE 0.6D.3B — negociação com autoridade no servidor.
 * NULL -> negociando_v1 é persistido antes de enviar. Somente a invocação
 * original pode concluir em legado após recusa comprovada pré-efeitos da
 * venda. Crash, retry e resposta ambígua tornam o binding permanentemente V1.
 * Não há cópia local de flag nem migração de vendas já vinculadas.
 */

'use strict';

function escolherProtocolo(venda) {
  const protocolo = venda?.sync_protocolo;
  if (protocolo == null) return 'negociando_v1';
  if (protocolo === 'v1' || protocolo === 'negociando_v1') return 'v1';
  if (protocolo === 'legado') return 'legado';
  // Estado desconhecido não é uma venda nova. Não renegociar no escuro.
  throw new Error(`Protocolo de venda desconhecido: ${protocolo}`);
}

// Somente a invocação que persistiu NULL -> negociando_v1 pode usar esta
// decisão. Depois de crash/restart, negociando_v1 é V1, sem fallback.
// O contrato local do Web em fa1ae83 recusa com HTTP 409 antes de reservar
// pdv_operacoes e antes da RPC. A autenticação pode atualizar o heartbeat
// do terminal; isso não é efeito de venda/itens/estoque.
function recusaPreWrite(resposta) {
  if (resposta?.ok !== false) return false;
  if (resposta.motivo === 'sem_identidade') {
    return resposta.preWriteLocal === true && resposta.status == null;
  }
  return resposta.motivo === 'rota_desligada'
    && resposta.status === 409
    && resposta.corpo?.ok === false
    && resposta.corpo.motivo === 'rota_desligada'
    && resposta.corpo.estado == null;
}

function exigirCriacaoReconciliada(venda) {
  // Inclui negociando_v1 e valores desconhecidos: nenhum deles autoriza
  // alterar os dados necessários para reconciliar uma criação ambígua.
  if (!venda.remote_id && venda.sync_protocolo != null && venda.sync_protocolo !== 'legado') {
    const erro = new Error('Esta venda está sendo enviada ao servidor e ainda não foi confirmada. '
      + 'Aguarde a sincronização terminar para alterá-la.');
    erro.codigo = 'v1_em_voo';
    throw erro;
  }
}

function lerPayloadPersistido(venda) {
  const erro = new Error(`Venda ${venda.id}: payload V1 persistido ausente ou inválido; requer reconciliação, sem reenvio automático`);
  erro.codigo = 'snapshot_v1_invalido';
  if (!venda.sync_payload_v1) throw erro;
  let payload;
  try { payload = JSON.parse(venda.sync_payload_v1); } catch { throw erro; }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!payload || payload.schema_version !== 1 || payload.venda_id !== venda.id
      || !uuid.test(payload.empresa_id) || !Array.isArray(payload.itens)
      || !payload.itens.every(i => i && uuid.test(i.id)
        && (i.produto_id === null || uuid.test(i.produto_id))
        && ['quantidade', 'preco_unitario', 'desconto', 'total'].every(k => Number.isFinite(i[k])))
      || !['total', 'subtotal', 'desconto', 'valor_pago', 'troco'].every(k => Number.isFinite(payload[k]))) throw erro;
  return payload;
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

module.exports = { escolherProtocolo, recusaPreWrite, exigirCriacaoReconciliada, lerPayloadPersistido,
  interpretarResposta, ESTADOS_SUCESSO, ESTADOS_TERMINAIS };

/**
 * arbitragemVenda.js — a arbitragem do orçamento é PRECONDIÇÃO da venda.
 *
 * ── O DEFEITO QUE ISTO REMOVE ───────────────────────────────────────────
 *
 * A 0.6C.6A fez a coisa certa pela metade: criou a arbitragem no servidor e
 * pôs um item `orcamento_converter` na fila. Só que a fila entrega
 * `venda/create` ANTES dele — e não por acidente de `created_at`, está
 * escrito em `database.js`:
 *
 *     ORDER BY CASE entidade WHEN 'cliente' THEN 0 WHEN 'venda' THEN 1 ELSE 2 END
 *
 * Então o terminal perdedor subia a venda e só DEPOIS descobria que tinha
 * perdido o orçamento. O vínculo ficava certo e a duplicidade de estoque
 * remoto — a razão de a fase existir — continuava acontecendo.
 *
 * ── A REGRA ─────────────────────────────────────────────────────────────
 *
 * Para venda com origem em orçamento, ANTES de qualquer efeito remoto —
 * venda, itens, estoque, financeiro, cliente, qualquer chamada derivada — o
 * servidor tem que ter confirmado:
 *
 *     orcamentos.id = X  AND  orcamentos.venda_id = V
 *
 * onde V é exatamente o UUID desta venda local. Se não confirmou, a venda
 * NÃO sobe. Não é "sobe e depois a gente conserta": depois não existe.
 *
 * ── POR QUE ISTO É UM MÓDULO E NÃO UM `if` NO MEIO DO SYNC ──────────────
 *
 * Porque a ordem da fila pode regredir, `recuperarVendasSemSync` pode
 * reenfileirar, e o retry manual entra por outra porta. A decisão mora num
 * lugar só, é pura, e é testada sozinha. O `sync.js` obedece.
 */

/**
 * A identidade do orçamento que o SERVIDOR conhece.
 *
 * `orcamentos.id` no SQLite é local. Em 56 dos 58 documentos do Escritório
 * ele coincide com o do servidor; em 2 não — o nº59 é local `d87547a7…` e
 * remoto `ee29e3b9…`. Mandar o id local nesses dois casos faria a RPC
 * responder `nao_encontrado`, e a venda legítima seria marcada como
 * conflito. É `remote_id ?? id`, a mesma identidade efetiva que
 * `orcamentoComando` já usa para falar com o servidor.
 */
function identidadeRemotaDoOrcamento(venda) {
  if (!venda || !venda.orcamento_id) return null;
  return venda.orcamento_remote_id || null;
}

/** Esta venda nasceu de um orçamento? */
function nasceuDeOrcamento(venda) {
  return !!(venda && venda.orcamento_id);
}

/**
 * O que fazer com a venda, dado o que a arbitragem respondeu.
 *
 * Três desfechos, e a diferença entre eles é a diferença entre perder uma
 * venda e duplicar estoque:
 *
 *   enviar   — o servidor confirmou que o orçamento é DESTA venda;
 *   conflito — outra venda levou (ou o documento recusa). Terminal: zero
 *              retry, zero efeito remoto, estado explícito no cliente;
 *   esperar  — ainda não se sabe. A venda fica pendente e tenta depois.
 *              Nenhum efeito remoto agora.
 *
 * `esperar` existe porque "não consegui confirmar" não é "perdi". Tratar
 * indisponibilidade como conflito marcaria como perdida uma venda que só
 * estava sem internet — e conflito é terminal, não tem volta.
 */
function decidirEnvio({ venda, resultado }) {
  if (!nasceuDeOrcamento(venda)) {
    return { acao: 'enviar', motivo: 'sem_orcamento' };
  }

  if (!identidadeRemotaDoOrcamento(venda)) {
    // O orçamento existe só aqui. Não há documento remoto para arbitrar, e
    // portanto não há confirmação possível — a regra não abre exceção. O
    // próprio orçamento está na fila à frente desta venda; no ciclo seguinte
    // ele tem remote_id e esta venda passa.
    return { acao: 'esperar', motivo: 'orcamento_sem_identidade_remota' };
  }

  if (!resultado) return { acao: 'esperar', motivo: 'sem_resposta' };

  if (resultado.tipo === 'ok') {
    const d = resultado.dados || {};
    const estado = resultado.estado || d.estado;
    if (estado !== 'convertido' && estado !== 'ja_convertido') {
      // Sucesso HTTP com estado que não é de sucesso: não inventa
      // interpretação. Espera e tenta de novo.
      return { acao: 'esperar', motivo: `estado_inesperado:${estado || 'ausente'}` };
    }
    // A CONFIRMAÇÃO É NOMINAL. Não basta "deu certo": o orçamento tem que
    // pertencer a ESTA venda. Sem esta comparação, um `ja_convertido` de
    // outra venda passaria por confirmação da nossa.
    const vencedora = d.venda_id || d.venda_vencedora_id || null;
    if (!vencedora) return { acao: 'esperar', motivo: 'resposta_sem_vencedora' };
    if (String(vencedora) !== String(venda.id)) {
      return { acao: 'conflito', estado: 'conflito_conversao', vencedora, dados: d };
    }
    return { acao: 'enviar', motivo: estado, revisao: d.revisao ?? null };
  }

  if (resultado.tipo === 'conflito_conversao') {
    const d = resultado.dados || {};
    return {
      acao: 'conflito', estado: 'conflito_conversao',
      vencedora: d.venda_vencedora_id || null, dados: d,
    };
  }

  if (resultado.tipo === 'recusado') {
    // conflito_versao, recusado_cancelado, nao_encontrado. Nenhum se resolve
    // repetindo, e nenhum autoriza a venda a subir.
    return {
      acao: 'conflito', estado: resultado.estado || 'recusado',
      vencedora: null, dados: resultado.dados || null,
    };
  }

  if (resultado.tipo === 'legado') {
    // Terminal sem a flag, ou sem identidade de terminal. NÃO existe caminho
    // legado seguro: o antigo escrevia pelo `anon` sem arbitragem nenhuma, e
    // era exatamente ele que deixava duas vendas levarem o mesmo orçamento.
    //
    // Fica `esperar`, não `conflito`: a venda não subiu, nada foi perdido, e
    // ligar a flag resolve. Se fosse conflito, um rollout incompleto marcaria
    // vendas boas como perdidas — e conflito não tem volta.
    return { acao: 'esperar', motivo: `rota_indisponivel:${resultado.motivo || '?'}` };
  }

  // 'erro' e qualquer coisa não prevista: transitório.
  return { acao: 'esperar', motivo: resultado.motivo || 'transitorio' };
}

/**
 * Esta venda pode voltar para a fila de envio?
 *
 * `recuperarVendasSemSync` reenfileirava qualquer venda com `remote_id IS
 * NULL`, olhando só o status COMERCIAL. A perdedora de uma arbitragem tem
 * `remote_id` nulo para sempre — de propósito — então ela voltava para a fila
 * em todo ciclo, e em algum deles subiria.
 */
const SYNC_STATUS_TERMINAIS = ['conflito_orcamento'];

function podeReenfileirar(venda) {
  if (!venda) return false;
  return !SYNC_STATUS_TERMINAIS.includes(venda.sync_status);
}

module.exports = {
  nasceuDeOrcamento,
  identidadeRemotaDoOrcamento,
  decidirEnvio,
  podeReenfileirar,
  SYNC_STATUS_TERMINAIS,
};

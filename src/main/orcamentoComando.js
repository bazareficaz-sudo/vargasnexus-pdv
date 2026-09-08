/**
 * orcamentoComando.js — UM lugar decide o que acontece com um orçamento.
 *
 * ── POR QUE ISTO EXISTE ─────────────────────────────────────────────────
 *
 * O piloto de orçamentos foi NO-GO porque havia QUATRO caminhos que salvavam
 * um orçamento, e eu migrei um só:
 *
 *     main.js:419  registrar   → api.sincronizarOrcamento      (imediato)
 *     main.js:457  atualizar   → api.atualizarOrcamento        (imediato)
 *     main.js:443  cancelar    → api.atualizarStatusOrcamento  (imediato)
 *     sync.js      fila        → migrado
 *
 * No caminho feliz a chamada imediata resolve e a fila nunca roda. Migrei
 * exatamente o ramo que quase nunca executa, e o orçamento nº 59 foi gravado
 * pelo legado com a flag ligada, sem deixar rastro.
 *
 * Agora os quatro chamam esta função. A fila volta a ser o que o comentário
 * original dizia que ela era: transporte e reexecução da MESMA operação, não
 * uma segunda implementação da regra.
 *
 * ── AS TRÊS IDENTIDADES, QUE CONTINUAM SEPARADAS ────────────────────────
 *
 *     id local      estável, nasce no SQLite, é o que a fila e a
 *                   idempotência usam. NUNCA é reescrito.
 *     remote_id     como o servidor conhece o documento. Pode ter nascido
 *                   diferente do id local, nos 55 orçamentos anteriores.
 *     numero        referência comercial, do servidor, imutável após criar.
 *
 * `orcamento_id_efetivo = remote_id ?? id_local` serve só para LOCALIZAR o
 * documento no servidor. Sem essa regra, editar um orçamento antigo mandaria
 * o id local, a RPC não acharia linha, trataria como criação — e nasceria um
 * segundo documento com número novo.
 *
 * ── AS DEPENDÊNCIAS SÃO INJETADAS ───────────────────────────────────────
 *
 * Não por gosto por abstração: é o que permite exercitar este fluxo em teste
 * sem Electron, sem SQLite e sem rede. A ausência desse teste foi o que me
 * deixou declarar "pronto para piloto" sobre um caminho que ninguém chamava.
 */

/** Ações possíveis. Cada uma tem chave própria, para replay não se confundir. */
const ACOES = ['salvar', 'cancelar'];

function criarComandoOrcamento({ db, api, terminal, log = console }) {
  /**
   * Executa a operação de orçamento pelo caminho certo.
   *
   * `acao` = 'salvar' cobre criação e edição — o servidor decide qual é pelo
   * que existe. Ter dois verbos foi o que permitiu, no caminho antigo, que
   * status e conteúdo andassem separados.
   */
  async function executar(orcamentoLocalId, acao = 'salvar') {
    if (!ACOES.includes(acao)) throw new Error(`Ação de orçamento desconhecida: ${acao}`);

    const orc = db.orcamentos.getById(orcamentoLocalId);
    if (!orc) return { tipo: 'sem_orcamento' };

    const idEfetivo = orc.remote_id || orc.id;
    const base = Number(orc.revisao_base || 0);

    // A chave PERSISTIDA vence. Ela só é montada uma vez, quando a operação
    // começa, e sobrevive a timeout, fechamento, reinício e replay porque
    // está em disco — não porque alguém se lembrou de recalculá-la igual.
    let chave = orc.op_chave;
    if (!chave) {
      chave = `${idEfetivo}:r${base}:${acao}`;
      db.orcamentos.marcarOperacaoPendente(orc.id, chave);
    }

    const payload = db.orcamentos.payloadSync(orc.id);
    const r = await api.salvarOrcamentoAutenticado({
      orcamento_id: idEfetivo,
      revisao_base: base,
      idempotency_key: chave,
      acao,
      orc: { ...orc, ...payload },
      itens: payload.itens || [],
    });

    if (r.tipo === 'ok') {
      // O servidor confirmou. Só agora a revisão avança — nunca por a
      // requisição ter sido enviada.
      db.orcamentos.confirmarSincronizacao(orc.id, {
        remote_id: r.dados.orcamento_id || idEfetivo,
        revisao: r.dados.revisao,
      });
      // E só agora a fila é encerrada, senão ela criaria uma revisão fantasma.
      db.sync.concluirPendentesDeOrcamento(orc.id);
      log.log(`[ORC] ${acao} nº ${r.dados.numero} rev ${r.dados.revisao}`
        + `${r.dados.repetido ? ' (replay)' : ''} pela rota autenticada`);
      return { tipo: 'ok', dados: r.dados };
    }

    if (r.tipo === 'conflito') {
      // Alguém editou noutro terminal. Insistir daqui sobrescreveria a edição
      // do outro — a perda silenciosa que esta fase existe para remover.
      db.orcamentos.marcarConflito(orc.id);
      db.sync.concluirPendentesDeOrcamento(orc.id);
      log.warn(`[ORC] Conflito de versão em ${orc.id} — recarregue antes de reenviar`);
      return { tipo: 'conflito', erro: r.erro };
    }

    if (r.tipo === 'legado') {
      // Rollout: este terminal ainda não foi migrado para esta operação.
      // O legado é permitido, mas NUNCA silencioso — é esta contagem que vai
      // autorizar (ou barrar) o corte do `anon`.
      await registrarFallback(acao, chave, r.motivo);
      return await pelaRotaAntiga(orc, payload, acao, chave);
    }

    // Transitório. Deixa na fila e tenta de novo com a MESMA chave: num
    // timeout o servidor pode ter gravado, e cair no legado criaria um
    // segundo documento.
    log.warn(`[ORC] Rota autenticada recusou (${r.motivo}): ${r.erro}`);
    return { tipo: 'erro', motivo: r.motivo, erro: r.erro };
  }

  async function registrarFallback(acao, chave, motivo) {
    try {
      await terminal.registrarFallback(`orcamentos.${acao}`, chave, motivo || 'nao_informado');
    } catch (e) {
      // Perder o registro do fallback não pode virar um segundo problema em
      // cima do primeiro. Mas fica no log local.
      log.warn('[ORC] Não consegui registrar o fallback:', e.message);
    }
  }

  /** O caminho antigo, agora chamado de um lugar só e sempre precedido do aviso. */
  async function pelaRotaAntiga(orc, payload, acao, chave) {
    try {
      if (acao === 'cancelar') {
        if (orc.remote_id) await api.atualizarStatusOrcamento(orc.remote_id, 'cancelado');
      } else if (!orc.remote_id) {
        const res = await api.sincronizarOrcamento(api.montarPayloadOrcamentoRemoto(payload));
        if (res && res.id) {
          // O legado gera o id no servidor. Guardamos como `remote_id` — e é
          // exatamente por isso que `orcamento_id_efetivo` existe: da próxima
          // vez, a rota nova vai localizar ESTE documento em vez de criar outro.
          db.orcamentos.confirmarSincronizacao(orc.id, { remote_id: res.id, revisao: null });
        }
      } else {
        await api.atualizarOrcamento(orc.remote_id, {
          cliente_nome: payload.cliente_nome, subtotal: payload.subtotal,
          desconto: payload.desconto, total: payload.total,
          observacao: payload.observacao, validade_dias: payload.validade_dias,
          itens: payload.itens,
        });
        db.orcamentos.confirmarSincronizacao(orc.id, { remote_id: orc.remote_id, revisao: null });
      }
      db.sync.concluirPendentesDeOrcamento(orc.id);
      return { tipo: 'legado', chave };
    } catch (e) {
      log.warn('[ORC] Caminho antigo também falhou:', e.message);
      return { tipo: 'erro', motivo: 'legado_falhou', erro: e.message };
    }
  }

  return { executar };
}

module.exports = { criarComandoOrcamento, ACOES };

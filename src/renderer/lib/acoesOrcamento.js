/**
 * acoesOrcamento.js — o que se pode fazer com um orçamento, num lugar só.
 *
 * ── POR QUE ISTO EXISTE (0.6C.4) ────────────────────────────────────────
 *
 * A regra estava escrita em TRÊS lugares e de três formas diferentes:
 *
 *   lista, botões    status === 'pendente' || status === 'aprovado'
 *   modal de detalhe status !== 'cancelado' && status !== 'convertido'
 *   guarda da função status !== 'cancelado' && status !== 'convertido'
 *   guarda de cancelar()  — NÃO EXISTIA
 *
 * As três concordam no que importa aqui — cancelado bloqueia — mas `cancelar()`
 * não tinha guarda nenhuma: só o botão escondido separava um orçamento
 * cancelado de ser cancelado de novo. Botão escondido não é regra, é aparência.
 *
 * Esta fase precisa que o bloqueio seja real, porque a partir dela o status
 * 'cancelado' passa a chegar SOZINHO, vindo de outro terminal, sem ninguém
 * clicar em nada aqui.
 *
 * ── O QUE NÃO MUDA ──────────────────────────────────────────────────────
 *
 * Nenhuma das três regras foi afrouxada nem alargada. A assimetria entre o
 * 'aberto' que veio do cloud e o 'pendente' criado aqui continua exatamente
 * como estava — é dívida registrada, de outra fase. O único comportamento novo
 * é `cancelar()` passar a recusar o que já está cancelado ou convertido.
 */
(function (raiz) {
  'use strict';

  /** Estados terminais: o documento acabou, e nada mais se faz com ele. */
  const TERMINAIS = ['cancelado', 'convertido'];

  function ehTerminal(o) {
    return !!o && TERMINAIS.indexOf(o.status) !== -1;
  }

  /**
   * Só o cabeçalho, vindo da listagem do cloud. Não dá para editar nem vender
   * o que não tem itens.
   */
  function ehSomenteNuvem(o) {
    return !!o && o._origem === 'cloud';
  }

  /**
   * FASE 0.6C.5 — snapshot completo de documento alheio, lido sob demanda.
   *
   * Tem cabeçalho, itens E revisão, tudo do mesmo instante. Dá para agir em
   * cima dele — mas online, e com a revisão do snapshot valendo como base:
   * se alguém editou no intervalo, o servidor recusa.
   */
  function ehSnapshotAlheio(o) {
    return !!o && o._origem === 'snapshot';
  }

  function podeEditar(o) { return !!o && !ehTerminal(o) && !ehSomenteNuvem(o); }
  function podeCancelar(o) { return !!o && !ehTerminal(o) && !ehSomenteNuvem(o); }

  /**
   * Converter em venda é a ÚNICA ação que documento alheio não recebe nesta
   * fase — decisão D-a.
   *
   * O motivo não é a leitura: é a escrita do outro lado. `marcarConvertido`
   * ainda é um quinto caminho, fora do `orcamentoComando`, gravando pelo
   * `anon` sem `registrarFallback`, e com o erro engolido em duas camadas — a
   * venda entra e o orçamento pode continuar aberto, em silêncio. Fazer
   * conversão cruzada em cima disso seria construir sobre um defeito conhecido.
   *
   * Sai do bloqueio na 0.6C.6, que trata a conversão inteira.
   */
  function podeConverter(o) {
    return !!o && !ehTerminal(o) && !ehSomenteNuvem(o) && !ehSnapshotAlheio(o);
  }

  /**
   * Regra dos botões da LISTA, mantida como estava: lá só aparecem para os
   * status vivos do vocabulário local. É mais estrita que as guardas acima, e
   * continua sendo — alargá-la mudaria 54 linhas históricas, o que não é
   * assunto desta fase.
   */
  function botoesDeEdicaoNaLista(o) {
    return podeEditar(o) && (o.status === 'pendente' || o.status === 'aprovado');
  }

  const api = { TERMINAIS, ehTerminal, ehSomenteNuvem, ehSnapshotAlheio,
    podeEditar, podeConverter, podeCancelar, botoesDeEdicaoNaLista };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.AcoesOrcamento = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

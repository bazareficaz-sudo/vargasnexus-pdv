/**
 * atualizacaoLiberada.js — a regra de "posso baixar esta versão?"
 *
 * O teto vem do servidor (pdv_terminais.atualizacao_liberada_ate, pela rota
 * GET /api/pdv/atualizacao). Sem teto, nada é baixado. A regra é pura para
 * ser testada sem Electron.
 */

const VERSAO_RE = /^\d+\.\d+\.\d+$/;

function versaoValida(v) {
  return typeof v === 'string' && VERSAO_RE.test(v.trim());
}

/** -1, 0 ou 1, comparando x.y.z numericamente (1.10.8 > 1.9.9). */
function compararVersao(a, b) {
  const pa = a.trim().split('.').map(Number);
  const pb = b.trim().split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/**
 * A versão oferecida pela Release pode ser baixada por este terminal?
 * Só se for maior que a atual E não passar do teto liberado. Qualquer dado
 * malformado é "não": na dúvida, o terminal fica onde está.
 */
function podeBaixar({ atual, oferecida, teto }) {
  if (![atual, oferecida, teto].every(versaoValida)) return false;
  return compararVersao(oferecida, atual) > 0 && compararVersao(oferecida, teto) <= 0;
}

module.exports = { versaoValida, compararVersao, podeBaixar };

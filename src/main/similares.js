// PRODUTOS SIMILARES — o mesmo item de marcas diferentes.
//
// O gestor agrupa no cadastro, pela coluna `produtos.grupo_similar`. O PDV usa
// o rotulo para oferecer as outras marcas ANTES de lancar o item, porque
// "disjuntor mono 32A" sem marca nao é um produto: é uma prateleira.
//
// Este modulo é a parte que nao depende de banco nem de tela, espelhando
// `pdv-vargas-web/src/lib/produtos/similares.ts`. Duas copias da regra
// divergem com o tempo; o que impede a divergencia aqui é que o lado que
// GRAVA o rotulo é um so (o cadastro, no web) e este lado so normaliza o que
// recebe, com a mesma formula.

/**
 * Forma canonica do rotulo: maiusculas, espacos simples, vazio vira null.
 *
 * "disjuntor  mono 32a " e "DISJUNTOR MONO 32A" tem de cair no MESMO grupo.
 * Sem isso, um espaco digitado a mais no cadastro separa o produto dos seus
 * similares e ninguem percebe — o modal simplesmente deixa de abrir, que é
 * indistinguivel de "este produto nao tem similares".
 */
function normalizarGrupoSimilar(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  return s || null;
}

/**
 * Chave de comparacao de nomes: sem acento, sem caixa, espacos simples.
 * Espelha `chaveNome` do web.
 */
function chaveNome(nome) {
  return String(nome ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

module.exports = { normalizarGrupoSimilar, chaveNome };

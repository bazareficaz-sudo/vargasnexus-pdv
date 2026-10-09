/**
 * compreJunto.js — "quem costuma levar junto", pelo servidor
 *
 * A sugestão local (database.js → sugestoes.porCarrinho) só enxerga as vendas
 * DESTE terminal, e não conhece os ajustes de "fixar" e "ocultar" feitos no
 * cadastro do produto no ERP. A rota GET /api/pdv/compre-junto responde com o
 * histórico da loja inteira e esses ajustes — a mesma função que o PDV web usa.
 *
 * A rota devolve só ids. Nome, preço e estoque saem do catálogo local, pela
 * mesma leitura que o resto do carrinho usa: uma fonte de preço só na tela.
 *
 * Sugestão é ajuda, nunca motivo de a venda esperar. Por isso:
 *   - devolve `null` sempre que o servidor não respondeu (offline, recusa,
 *     timeout) — quem chama cai na sugestão local, como antes;
 *   - tem timeout curto: o painel não pode ficar segurando o carrinho;
 *   - lembra a resposta por carrinho, porque o painel é redesenhado a cada
 *     mudança de quantidade e o conjunto de produtos quase nunca muda;
 *   - lembra também a FALHA por um minuto: offline, cada redesenho esperaria
 *     o timeout inteiro antes de mostrar a sugestão local.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIMITE = 6;
const TIMEOUT_MS = 3000;
const TTL_OK_MS = 5 * 60 * 1000;
const TTL_FALHA_MS = 60 * 1000;
const MAX_CACHE = 200;

function criarCompreJunto({
  chamar,                 // (ids, limite) => Promise<{ ok, dados?: { sugestoes } }>
  getProduto,             // (id) => linha local de produtos (com `estoque`) ou undefined
  agora = Date.now,
  timeoutMs = TIMEOUT_MS,
} = {}) {
  const cache = new Map(); // chave do carrinho -> { ate, valor }

  function lembrar(chave, valor, ttl) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(chave, { ate: agora() + ttl, valor });
  }

  async function perguntarAoServidor(ids) {
    let timer;
    const estourou = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, motivo: 'timeout' }), timeoutMs);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => chamar(ids, LIMITE)).catch((e) => ({ ok: false, motivo: 'erro', erro: e.message })),
        estourou,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function montar(linhas) {
    const lista = [];
    for (const l of linhas) {
      const p = getProduto(l.produto_id);
      // Inativo ou fora do PDV aqui no terminal: não oferece o que o balcão
      // não consegue vender.
      if (!p || p.ativo === 0 || p.ativo === false || p.disponivel_pdv === 0 || p.disponivel_pdv === false) continue;
      lista.push({
        id: p.id,
        nome: p.nome,
        emoji: p.emoji,
        preco: p.preco_venda,
        estoque: p.estoque,
        vezes: l.vezes,
        fixo: !!l.fixo,
        base_id: l.base_id,
      });
    }
    // Com estoque primeiro (mesma regra do PDV web): oferecer o que não tem
    // para entregar só frustra o cliente. Sem estoque continua, no fim — pode
    // ser encomenda, ou o saldo local estar atrasado. `sort` é estável: dentro
    // de cada grupo fica a ordem do servidor (fixados, depois mais vendidos).
    lista.sort((a, b) => Number(Number(b.estoque) > 0) - Number(Number(a.estoque) > 0));
    return lista;
  }

  /**
   * Sugestões para os produtos do carrinho, ou `null` se o servidor não
   * respondeu (quem chama usa a sugestão local).
   */
  async function sugerir(produtoIds) {
    const ids = [...new Set((produtoIds || []).filter((id) => typeof id === 'string' && UUID_RE.test(id)))].sort();
    // Produto criado só no terminal ainda não tem id do servidor: não há o
    // que perguntar, e "nenhuma sugestão" aqui esconderia a sugestão local.
    if (ids.length === 0) return null;

    const chave = ids.join(',');
    const lembrado = cache.get(chave);
    if (lembrado && lembrado.ate > agora()) return lembrado.valor && montar(lembrado.valor);

    const r = await perguntarAoServidor(ids);
    if (!r || !r.ok || !Array.isArray(r.dados?.sugestoes)) {
      lembrar(chave, null, TTL_FALHA_MS);
      return null;
    }
    // Guarda as LINHAS do servidor, não a lista montada: estoque e preço locais
    // mudam durante o dia, e são relidos a cada redesenho.
    lembrar(chave, r.dados.sugestoes, TTL_OK_MS);
    return montar(r.dados.sugestoes);
  }

  return { sugerir, _limparCache: () => cache.clear() };
}

module.exports = { criarCompreJunto };

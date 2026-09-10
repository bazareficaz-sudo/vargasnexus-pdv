/**
 * identidadeOrcamento.js — quem é o mesmo documento em duas listas.
 *
 * ── O DEFEITO QUE ISTO REMOVE ───────────────────────────────────────────
 *
 * A tela junta duas origens: o SQLite local e o cloud. A junção era feita
 * pelo `numero`:
 *
 *     for (const o of cloud)  mapa.set(String(o.numero), ...)
 *     for (const o of locais) mapa.set(String(o.numero), ...)
 *
 * O `numero` é referência COMERCIAL, não identidade. Ele é atribuído pelo
 * servidor e estimado pelo cliente, então as duas pontas podem discordar —
 * e discordavam. Duas consequências, e a segunda é a grave:
 *
 *   1. mesmo documento com números diferentes  ⇒ aparece DUAS vezes;
 *   2. documentos diferentes com o mesmo número ⇒ um ESCONDE o outro.
 *
 * Medido em produção em 09/09/2026, com 57 documentos locais e 57 no cloud:
 * 59 linhas para 58 documentos, e uma colisão real de número (o palpite local
 * 59 batendo no documento `ee29e3b9`, que é o nº59 oficial de outro dia).
 * Nada sumiu por sorte — o documento escondido tinha uma segunda linha local
 * com outro número. Sorte não é garantia.
 *
 * ── A CHAVE CERTA ───────────────────────────────────────────────────────
 *
 *     remote_id ?? id
 *
 * É a mesma regra de identidade efetiva que o orquestrador usa para falar com
 * o servidor (`orcamentoComando.js`). Nas linhas do cloud, `id` e `remote_id`
 * são ambos o id do servidor; nas locais, `remote_id` é ele quando já houve
 * sincronização e `null` antes disso — quando ainda não existe documento
 * remoto com que colidir.
 *
 * ── E O NÚMERO NA TELA ──────────────────────────────────────────────────
 *
 * Quando as duas origens têm o mesmo documento, a linha local vence (ela tem
 * itens, telefone, forma de pagamento — o cloud traz só o cabeçalho), MENOS
 * no `numero`: esse é do servidor. É a mesma regra de autoridade que vale na
 * gravação, aplicada na leitura. Sem ela, um documento cujo número local
 * ficou defasado continuaria exibindo o número errado até o down-sync passar.
 */
(function (raiz) {
  'use strict';

  /** Identidade técnica do documento. Nunca o número. */
  function chaveDeIdentidade(o) {
    if (!o) return '';
    return String(o.remote_id || o.id || '');
  }

  /**
   * Junta locais e cloud num conjunto sem repetição.
   *
   * `_origem` diz de onde a linha veio, e é o que a tela usa para decidir
   * quais ações oferecer: 'cloud' não tem dados locais, então não edita nem
   * converte em venda.
   */
  function mesclar(locais, cloud) {
    const mapa = new Map();
    for (const o of cloud || []) {
      mapa.set(chaveDeIdentidade(o), Object.assign({}, o, { _origem: 'cloud' }));
    }
    for (const o of locais || []) {
      const chave = chaveDeIdentidade(o);
      const doCloud = mapa.get(chave);
      const linha = Object.assign({}, o, { _origem: o.remote_id ? 'sync' : 'local' });
      // Autoridade do número: se o servidor tem opinião sobre este documento,
      // é a dele que vale.
      if (doCloud && doCloud.numero != null) linha.numero = doCloud.numero;
      mapa.set(chave, linha);
    }
    return Array.from(mapa.values());
  }

  const api = { chaveDeIdentidade, mesclar };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.IdentidadeOrcamento = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

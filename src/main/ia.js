/**
 * ia.js — Integração com Claude (Anthropic) para enriquecimento de produtos
 */

const fetch = require('node-fetch');
const Store = require('electron-store');
const store = new Store();

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';

function getApiKey() {
  return store.get('config.anthropic_key') || '';
}

async function callClaude(prompt) {
  const key = getApiKey();
  if (!key) throw new Error('Chave da API Anthropic não configurada. Acesse Config → IA para cadastrar.');

  console.log('[IA] Chamando Claude, modelo:', MODEL, '| key:', key.slice(0,12) + '...');
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error('[IA] Erro HTTP', res.status, JSON.stringify(err));
    throw new Error(err.error?.message || `HTTP ${res.status}`);
  }
  console.log('[IA] Resposta OK');

  const data = await res.json();
  return data.content?.[0]?.text || '';
}

/**
 * Sugere dados fiscais para um produto.
 * Retorna objeto com ncm, cfop, icms_cst, icms_origem, pis_cst, cofins_cst.
 */
async function sugerirFiscal(nome, categoria, unidade) {
  const prompt = `Você é um especialista em tributação brasileira. Dado o produto abaixo, retorne APENAS um JSON válido com os campos fiscais. Não escreva mais nada além do JSON.

Produto: "${nome}"
Categoria: "${categoria || 'não informada'}"
Unidade: "${unidade || 'UN'}"

Retorne exatamente este JSON (sem markdown, sem explicações):
{
  "ncm": "XXXXXXXX",
  "cfop": "5102",
  "icms_cst": "400",
  "icms_origem": 0,
  "pis_cst": "07",
  "cofins_cst": "07",
  "justificativa_ncm": "explicação em 1 linha"
}

Regras:
- NCM: 8 dígitos sem ponto (ex: "73239900")
- CFOP: use 5102 para venda de mercadoria no estado, 6102 para fora do estado — use 5102 por padrão
- ICMS CST (Simples Nacional): use CSOSN 400 para a maioria; 500 se ST
- icms_origem: 0=nacional, 1=importado direto, 2=importado merc.interno
- PIS/COFINS CST: use 07 para Simples Nacional (isento)`;

  const texto = await callClaude(prompt);

  // Extrair JSON da resposta (Claude pode envolver com ```json```)
  const match = texto.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('IA não retornou JSON válido');
  return JSON.parse(match[0]);
}

/**
 * Gera descrição comercial para um produto.
 */
async function gerarDescricao(nome, categoria, marca, unidade) {
  const prompt = `Gere uma descrição comercial curta (2-3 frases) para este produto de uma loja de varejo brasileira. Seja objetivo e informativo. Não use emojis.

Produto: "${nome}"
Categoria: "${categoria || ''}"
Marca: "${marca || ''}"
Unidade: "${unidade || 'UN'}"

Retorne apenas a descrição, sem título, sem aspas.`;

  return await callClaude(prompt);
}

/**
 * Enriquecimento em lote: recebe lista de {id, nome, categoria, unidade}
 * Retorna lista de {id, ncm, cfop, icms_cst, icms_origem, pis_cst, cofins_cst}
 */
async function enriquecerLote(produtos) {
  const lista = produtos.map((p, i) => `${i + 1}. ID:${p.id} | "${p.nome}" | cat:${p.categoria || '-'}`).join('\n');

  const prompt = `Você é um especialista em tributação brasileira. Para cada produto abaixo, retorne APENAS um array JSON com os dados fiscais. Não escreva mais nada além do JSON.

Produtos:
${lista}

Retorne exatamente este formato (array, sem markdown):
[
  {"id": "ID_DO_PRODUTO", "ncm": "XXXXXXXX", "cfop": "5102", "icms_cst": "400", "icms_origem": 0, "pis_cst": "07", "cofins_cst": "07"},
  ...
]

Regras:
- NCM: 8 dígitos sem ponto
- CFOP: 5102 por padrão
- ICMS CSOSN: 400 para maioria no Simples; 500 se ST
- PIS/COFINS: 07 (isento Simples)
- Inclua TODOS os produtos na resposta, na mesma ordem`;

  const texto = await callClaude(prompt);
  // Tentar extrair array JSON mesmo com texto antes/depois
  const match = texto.match(/\[[\s\S]*\]/);
  if (!match) {
    console.error('[IA] Resposta lote inválida:', texto.slice(0, 300));
    throw new Error('IA não retornou JSON válido');
  }
  try {
    return JSON.parse(match[0]);
  } catch(e) {
    // Tentar extrair objetos individuais se o array estiver cortado
    const objetos = [...match[0].matchAll(/\{[^{}]*"id"[^{}]*\}/g)].map(m => {
      try { return JSON.parse(m[0]); } catch { return null; }
    }).filter(Boolean);
    if (objetos.length) return objetos;
    throw new Error('IA retornou JSON malformado');
  }
}

/**
 * Busca imagem do produto por EAN e/ou nome.
 * Tenta múltiplas APIs gratuitas em sequência.
 */
async function buscarImagemProduto(nome, ean) {
  const candidatos = [];

  // 1. UPCItemDB (free, sem key, bom para produtos de marca)
  if (ean) {
    try {
      const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(ean)}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        const item = data?.items?.[0];
        if (item) {
          const imgs = (item.images || []).filter(Boolean);
          imgs.forEach(u => candidatos.push({ url: u, fonte: 'UPCItemDB', titulo: item.title || nome }));
        }
      }
    } catch(e) { console.warn('[IA Imagem] UPCItemDB:', e.message); }
  }

  // 2. Open Food Facts (gratuito, para alimentos)
  if (ean && candidatos.length === 0) {
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(ean)}.json`);
      if (res.ok) {
        const data = await res.json();
        const img = data?.product?.image_url || data?.product?.image_front_url;
        if (img) candidatos.push({ url: img, fonte: 'Open Food Facts', titulo: data.product?.product_name || nome });
      }
    } catch(e) { console.warn('[IA Imagem] OpenFoodFacts:', e.message); }
  }

  // 3. Cosmos (API brasileira de produtos por EAN)
  if (ean && candidatos.length === 0) {
    try {
      const res = await fetch(`https://api.cosmos.bluesoft.com.br/gtins/${encodeURIComponent(ean)}`, {
        headers: { 'X-Cosmos-Token': 'sem-token', 'Accept': 'application/json' },
      });
      if (res.ok) {
        const data = await res.json();
        const img = data?.thumbnail_url || data?.image_url;
        if (img) candidatos.push({ url: img, fonte: 'Cosmos BR', titulo: data.description || nome });
      }
    } catch(e) { console.warn('[IA Imagem] Cosmos:', e.message); }
  }

  // 4. Claude sugere termos de busca para o usuário procurar manualmente
  const termoBusca = encodeURIComponent(`${nome} produto foto`);
  const urlBuscaGoogle = `https://www.google.com/search?q=${termoBusca}&tbm=isch`;
  const urlBuscaMercadoLivre = `https://lista.mercadolivre.com.br/${encodeURIComponent(nome)}`;

  return {
    candidatos,
    busca_manual: {
      google_imagens: urlBuscaGoogle,
      mercado_livre: urlBuscaMercadoLivre,
    },
  };
}

module.exports = { sugerirFiscal, gerarDescricao, enriquecerLote, getApiKey, buscarImagemProduto };

/**
 * nfce.js — a nota do balcão, emitida pelo servidor.
 *
 * ── O QUE ISTO SUBSTITUI ─────────────────────────────────────────────────
 *
 * `focusnfe.js`, que montava a nota aqui dentro e falava direto com o
 * provedor. Aquele caminho exigia o token fiscal no terminal — credencial da
 * conta, em seis máquinas de balcão, recuperável de qualquer cópia do
 * programa. É a mesma regra do token do Mercado Pago: vive no servidor.
 *
 * E não era só o segredo. Ele mandava CSOSN 400 e PIS/COFINS 07 fixos, de um
 * regime que não é o do emitente real desta operação; não rateava desconto
 * (Rejeição 865); e usava `NFCe-<numero>` como referência, sendo que `numero`
 * repete entre terminais. Nota errada, emitida com confiança. Desde a
 * migração do Base44 ele também não tinha mais de onde ler token nenhum, e
 * tudo o que o botão [F] fazia era dizer "Token FocusNFe não configurado".
 *
 * ── O QUE ESTE MÓDULO FAZ ────────────────────────────────────────────────
 *
 * Três chamadas, todas pela rota autenticada pelo token deste terminal:
 *
 *   emitir   → POST /api/pdv/nfce        (o servidor emite e grava na venda)
 *   cupom    → GET  /api/pdv/nfce/danfe  (HTML já ajustado para a bobina)
 *   politica → GET  /api/pdv/politica-fiscal
 *
 * Nenhuma delas conhece provedor, CSC, CFOP ou CSOSN. Isso é do servidor, e
 * ficar de um lado só é o que impede duas versões da mesma regra.
 */

const terminal = require('./terminal');
const db = require('./database');

/**
 * Normaliza a resposta de `chamarProtegida` num desfecho que a tela entende.
 *
 * Pura de propósito: é a única parte disto com regra, e a regra é "nunca
 * dizer que emitiu sem o servidor ter dito". `chamarProtegida` devolve o
 * corpo em `dados` no sucesso e em `corpo` na recusa; `estado` é o que a rota
 * usa para distinguir autorizada, já emitida, rejeitada e em voo.
 */
function lerDesfechoDaEmissao(r) {
  if (!r) return { ok: false, estado: 'sem_resposta', erro: 'Sem resposta do servidor' };

  if (r.ok) {
    const d = r.dados || {};
    return {
      ok: true,
      estado: d.estado || 'autorizada',
      jaEstava: d.estado === 'ja_emitida',
      numero: d.numero || null,
      serie: d.serie || null,
      chave: d.chave || null,
    };
  }

  // Recusas que NÃO são problema do caixa, traduzidas antes de chegar na tela.
  if (r.motivo === 'sem_identidade') {
    return { ok: false, estado: 'sem_identidade', erro: 'Este terminal ainda não foi ativado no painel — a nota tem que sair pelo sistema web.' };
  }
  if (r.motivo === 'rota_desligada') {
    return { ok: false, estado: 'rota_desligada', erro: 'A emissão por este terminal ainda não foi liberada no painel.' };
  }
  if (r.motivo === 'rede') {
    return { ok: false, estado: 'rede', erro: 'Sem conexão com o servidor — a nota não saiu. Tente de novo em instantes.' };
  }

  const corpo = r.corpo || {};
  return {
    ok: false,
    estado: corpo.estado || r.motivo || 'recusado',
    erro: corpo.erro || r.erro || 'A emissão não foi autorizada',
  };
}

/**
 * Qual id o servidor conhece.
 *
 * Venda feita pelo protocolo V1 tem o MESMO id nos dois lados, e aí isto é
 * identidade. Venda anterior a ele tem id local diferente do remoto — e é por
 * isso que a função existe em vez de mandar o id direto: pedir emissão com o
 * id local de uma venda antiga faria o servidor responder "venda não
 * encontrada" sobre uma venda que está ali.
 *
 * Id que não existe no banco local (a tela de Vendas de quem vê todos os
 * terminais lista vendas da NUVEM) passa como está: ele já é o id remoto.
 */
function idRemotoDe(id) {
  let local = null;
  try { local = db.vendas.getById(id); } catch { /* banco fechado, tanto faz */ }
  if (!local) return { remoto: id, local: null };
  return { remoto: local.remote_id || null, local };
}

async function emitir(id, cpfCnpj) {
  const { remoto, local } = idRemotoDe(id);

  if (!remoto) {
    // Venda que ainda não subiu. A nota precisa da venda no servidor — e o
    // operador precisa saber que o problema é sincronismo, não fiscal.
    return {
      ok: false,
      estado: 'venda_nao_subiu',
      erro: 'Esta venda ainda não foi enviada para o servidor. Assim que ela sincronizar, a nota pode ser emitida.',
    };
  }

  const r = await terminal.chamarProtegida('/api/pdv/nfce', {
    venda_id: remoto,
    cpf_cnpj: cpfCnpj || null,
    // Chave estável por venda: a mesma na primeira tentativa e na décima.
    // Resposta perdida devolve o mesmo desfecho em vez de emitir de novo.
    idempotency_key: terminal.chaveDe('nfce', remoto),
  });

  const desfecho = lerDesfechoDaEmissao(r);

  // Espelha no banco local para a lista de Vendas mostrar o selo sem depender
  // da nuvem. Falhar aqui não desfaz a nota: ela já está autorizada no
  // servidor, e dizer o contrário seria pior do que não espelhar.
  if (desfecho.ok && local?.id) {
    try {
      db.vendas.atualizarNfce(local.id, {
        chave: desfecho.chave || '',
        numero: desfecho.numero || '',
        serie: desfecho.serie || '',
        url_pdf: '',
        referencia: remoto,
      });
    } catch (e) {
      console.warn('[NFCE] Nota emitida, mas o espelho local falhou:', e.message);
    }
  }

  return desfecho;
}

/** O cupom da nota, em HTML pronto para a bobina. */
async function cupom(id) {
  const { remoto } = idRemotoDe(id);
  if (!remoto) return { ok: false, erro: 'Esta venda ainda não foi enviada para o servidor.' };

  const r = await terminal.chamarProtegida(`/api/pdv/nfce/danfe?venda_id=${encodeURIComponent(remoto)}`, null, { metodo: 'GET' });
  if (!r.ok) {
    const corpo = r.corpo || {};
    return { ok: false, erro: corpo.erro || r.erro || 'Não foi possível obter o cupom da nota' };
  }
  const d = r.dados || {};
  return { ok: true, html: d.danfe_html || null, url: d.danfe_url || null, numero: d.numero || null, chave: d.chave || null };
}

/**
 * A política da loja: quem decide emitir no balcão.
 *
 * `undefined` quando não deu para perguntar (terminal sem identidade, rede
 * fora, rota antiga) — quem chama mantém o que estava guardado, pelo mesmo
 * raciocínio da mensagem do cupom: política velha é melhor que política
 * nenhuma, e nada aqui bloqueia venda.
 */
async function politica() {
  const r = await terminal.chamarProtegida('/api/pdv/politica-fiscal', null, { metodo: 'GET' });
  if (!r.ok) {
    if (r.motivo !== 'sem_identidade') {
      console.warn('[NFCE] Nao foi possivel ler a politica fiscal:', r.motivo, r.erro);
    }
    return undefined;
  }
  const d = r.dados || {};
  if (typeof d.emissao_balcao !== 'string') return undefined;
  return {
    emissao_balcao: d.emissao_balcao,
    emitir_no_balcao: !!d.emitir_no_balcao,
    emitir_ao_fechar: !!d.emitir_ao_fechar,
    pedir_documento: !!d.pedir_documento,
  };
}

module.exports = { emitir, cupom, politica, lerDesfechoDaEmissao, idRemotoDe };

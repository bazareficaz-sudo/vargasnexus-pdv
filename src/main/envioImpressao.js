// A URL DO TÚNEL MORRE A CADA REINÍCIO DO CAIXA.
//
// O Quick Tunnel ganha endereço novo toda vez que o CAIXA reinicia. Os outros
// terminais só descobrem no sync seguinte — até cinco minutos depois. Nessa
// janela eles mandam o job para um endereço que já não existe, e o vendedor vê
// "erro de impressão" sem ter o que fazer a respeito.
//
// Em vez de esperar o relógio: falhou, rebusca a URL AGORA e tenta de novo. A
// janela cai de minutos para segundos.
//
// ── POR QUE UM MÓDULO, E NÃO UMA FUNÇÃO DENTRO DO main.js ───────────────
//
// Porque aqui há decisões, e decisão sem teste é promessa. Com as dependências
// entrando por parâmetro, dá para provar cada caminho sem Electron, sem rede e
// sem um CAIXA de verdade do outro lado.

/**
 * @param enviar         (dados) => Promise  — lança quando falha
 * @param lerUrlAtual    () => string
 * @param buscarUrlNova  () => Promise<string|null>
 * @param salvarUrl      (url) => void
 */
async function enviarComRefresco(dados, { enviar, lerUrlAtual, buscarUrlNova, salvarUrl, log } = {}) {
  try {
    return await enviar(dados);
  } catch (primeiroErro) {
    const anterior = String((lerUrlAtual && lerUrlAtual()) || '');

    let nova = null;
    try {
      nova = buscarUrlNova ? await buscarUrlNova() : null;
    } catch {
      // Servidor fora também. Não há URL nova a buscar, e o erro que
      // interessa é o PRIMEIRO — o da impressão, não o da consulta. Quem lê
      // "erro ao buscar URL" vai investigar o lugar errado.
    }

    // Mesma URL quer dizer que o endereço não era o problema: é o CAIXA
    // desligado, a impressora sem papel, a rede fora. Repetir daria o mesmo
    // erro dois segundos mais tarde, com o cliente esperando.
    if (!nova || nova === anterior) throw primeiroErro;

    if (salvarUrl) salvarUrl(nova);
    if (log) log(nova);

    // UMA segunda tentativa, e só. Se esta falhar, o erro que sobe é o DELA:
    // é o mais recente e o que descreve o endereço que está valendo agora.
    return await enviar(dados);
  }
}

module.exports = { enviarComRefresco };

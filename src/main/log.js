/**
 * log.js — o processo principal passa a deixar rastro em disco.
 *
 * Até aqui só o updater usava electron-log. Todo o resto do main falava por
 * console.log/warn/error, que em produção não vai a lugar nenhum: o terminal
 * roda empacotado, sem console ligado. O efeito prático apareceu no incidente
 * da baixa de estoque — o código avisava "[ESTOQUE] Falha ao registrar..."
 * exatamente como devia, e ninguém nunca viu esse aviso, nem podia ver.
 *
 * Este módulo redireciona console.* do main para o arquivo de log do
 * electron-log (%APPDATA%\pdv-vargas\logs\main.log), mantendo o
 * comportamento normal quando há console (modo dev). Precisa ser o PRIMEIRO
 * require do main.js, antes dos módulos que logam na carga.
 */

const log = require('electron-log');

log.transports.file.level = 'info';
log.transports.file.maxSize = 10 * 1024 * 1024; // 10 MB, depois rotaciona
log.transports.console.level = 'info';

// console.* do processo principal passa a escrever no arquivo. Mantém a
// assinatura variádica (o código chama console.warn('[X]', err.message)).
console.log = (...args) => log.info(...args);
console.info = (...args) => log.info(...args);
console.warn = (...args) => log.warn(...args);
console.error = (...args) => log.error(...args);
console.debug = (...args) => log.debug(...args);

// Falha assíncrona sem catch também deixa rastro — era outra classe de erro
// que sumia sem deixar nada para ler depois.
process.on('unhandledRejection', (motivo) => {
  log.error('[PROCESSO] Promise rejeitada sem tratamento:', motivo?.stack || motivo);
});
process.on('uncaughtException', (err) => {
  log.error('[PROCESSO] Exceção não capturada:', err?.stack || err);
});

module.exports = log;

/**
 * execucaoUnica.js — trava de execução única (single-flight) dentro do MESMO
 * processo.
 *
 * Existe porque duas entradas diferentes chamam a mesma operação sem saber uma
 * da outra: Enter e clique chamam `_finalizarComVendedor` direto (pdv.js), e
 * `syncFila` é disparada a cada venda registrada (main.js) ao mesmo tempo em
 * que o sync periódico pode estar drenando a mesma fila (sync.js).
 *
 * O QUE ELA GARANTE: enquanto uma execução estiver em andamento, uma segunda
 * chamada não entra no caminho de escrita — ela recebe a promise da execução
 * que já está rodando.
 *
 * O QUE ELA NÃO GARANTE — e isto é deliberado, não limitação a corrigir depois:
 * nada sobre crash, restart, retry de fila, outro terminal ou reenvio remoto.
 * A trava vive em memória e morre com o processo. Idempotência de verdade é
 * chave no servidor, e é assunto da 0.6D.2/0.6D.3. Confundir as duas coisas
 * seria vender como resolvido o problema que a 0.6D.0 mediu em produção.
 *
 * Carregado nos dois mundos, no mesmo padrão de `identidadeOrcamento.js`:
 * `require()` no processo main e `<script>` no renderer (que não tem
 * require — contextIsolation ligada).
 */
(function (raiz) {
  'use strict';

  /**
   * Cria uma trava independente. Cada operação que precisa de exclusão mútua
   * tem a sua — travas separadas não competem entre si.
   *
   * Uso:
   *   const trava = criarExecucaoUnica()
   *   const { entrou, promise } = trava(() => fazerAlgo())
   *   if (!entrou) return            // no-op: alguém já está fazendo
   *   return promise                 // ou: junta-se à execução em andamento
   */
  function criarExecucaoUnica() {
    let emAndamento = null;

    return function executar(fn) {
      if (emAndamento) return { entrou: false, promise: emAndamento };

      let promise;
      try {
        promise = Promise.resolve(fn());
      } catch (err) {
        // `fn` que estoura de forma síncrona não pode deixar a trava presa —
        // seria um deadlock permanente até o operador reiniciar o PDV.
        promise = Promise.reject(err);
      }

      emAndamento = promise;

      // Libera em sucesso E em erro. Este `then` também marca a promise como
      // tratada: quem chamou pode descartá-la (o caminho no-op descarta) sem
      // gerar unhandled rejection. Quem quiser o erro continua recebendo a
      // promise original, com a rejeição intacta.
      promise.then(liberar, liberar);

      function liberar() {
        if (emAndamento === promise) emAndamento = null;
      }

      return { entrou: true, promise };
    };
  }

  const api = { criarExecucaoUnica };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else raiz.ExecucaoUnica = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

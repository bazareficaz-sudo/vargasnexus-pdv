const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { stripTypeScriptTypes } = require('node:module');

// Inspeção e execução do contrato LOCAL, pinado. Não consulta rede/banco.
// Não representa prova do código implantado em produção.
const WEB_COMMIT = 'fa1ae83e8400848d57877cc2f6ae1e1ab0599377';
const repo = process.env.PDV_WEB_REPO || path.resolve(__dirname, '../../pdv-vargas-web');
const disponivel = fs.existsSync(path.join(repo, '.git')) && typeof stripTypeScriptTypes === 'function';
function fonte(file) {
  return execFileSync('git', ['-C', repo, 'show', `${WEB_COMMIT}:${file}`], { encoding: 'utf8' });
}
function carregar(file, nome, deps) {
  let js = stripTypeScriptTypes(fonte(file));
  js = js.replace(/^import .*$/gm, '').replace(/^export /gm, '');
  return vm.runInNewContext(`(function(${Object.keys(deps).join(',')}) { ${js}\nreturn ${nome}; })`,
    { Date })(...Object.values(deps));
}

test('contrato Web local: rota_desligada não reserva operação nem chama RPC; só heartbeat',
  { skip: !disponivel && 'Requer checkout Web local e Node com stripTypeScriptTypes' }, async () => {
    const efeitos = [];
    const claims = { terminal_id: 'terminal-teste', empresa_id: 'empresa-teste', tipo: 'pdv_terminal' };
    const sb = { from(tabela) {
      return {
        select() { return this; }, eq() { return this; },
        async maybeSingle() { return { data: tabela === 'pdv_terminais'
          ? { id: claims.terminal_id, empresa_id: claims.empresa_id, status: 'ativo', rotas_habilitadas: {} }
          : { id: claims.empresa_id, ativo: true, tenant_id: null } }; },
        update(dados) {
          efeitos.push([tabela, Object.keys(dados)]);
          assert.equal(tabela, 'pdv_terminais');
          assert.deepEqual(Object.keys(dados), ['ultima_atividade_em']);
          return { eq: async () => ({}) };
        },
        insert() { throw new Error('Recusa não pode reservar operação'); },
      };
    }, rpc() { throw new Error('Recusa não pode chamar RPC'); } };
    const NextResponse = { json: (body, opts) => ({ body, status: opts?.status || 200 }) };
    const acesso = fonte('src/lib/pdv/decidirAcesso.ts');
    const decidirAcesso = carregar('src/lib/pdv/decidirAcesso.ts', 'decidirAcesso', {});
    const tokenDoCabecalho = carregar('src/lib/pdv/decidirAcesso.ts', 'tokenDoCabecalho', {});
    const autenticarTerminalPdv = carregar('src/lib/pdv/autenticarTerminal.ts', 'autenticarTerminalPdv', {
      NextResponse, createAdminClient: () => sb,
      verificarComRotacao: () => ({ ok: true, claims }), segredosDeVerificacao: () => [],
      decidirAcesso, tokenDoCabecalho,
    });
    const respostaDeRecusa = carregar('src/lib/pdv/autenticarTerminal.ts', 'respostaDeRecusa', {
      NextResponse, decidirAcesso, tokenDoCabecalho,
    });
    const operacaoProtegida = carregar('src/lib/pdv/operacaoProtegida.ts', 'operacaoProtegida', {
      NextResponse, autenticarTerminalPdv, respostaDeRecusa,
      createAdminClient: () => { throw new Error('Recusa chegou ao executor de operação'); },
      conferirEmpresaDoCorpo: () => null,
      decidirIdempotencia: () => { throw new Error('Recusa chegou à idempotência'); },
      chaveIdempotenciaValida: () => true,
    });
    const POST = carregar('src/app/api/pdv/vendas/sincronizar-v1/route.ts', 'POST', {
      operacaoProtegida,
      createAdminClient: () => { throw new Error('Recusa chegou à RPC'); },
    });
    const resultado = await POST({ headers: { get: () => 'Bearer teste' }, json: async () => ({ payload: {} }) });
    assert.equal(resultado.status, 409);
    assert.equal(resultado.body.motivo, 'rota_desligada');
    assert.equal(efeitos.length, 1, 'existe heartbeat; não afirmar zero escritas no servidor');
    assert.match(acesso, /rotas_habilitadas\?\.\[operacao\]/);
  });

test('sem_identidade local é decidido antes do fetch; recusa remota não recebe prova local', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/terminal.js'), 'utf8');
  const inicio = src.indexOf('async function chamarProtegida(');
  const fim = src.indexOf('\nfunction chaveDe(', inicio);
  let token = null, requests = 0;
  const chamar = vm.runInNewContext(`(${src.slice(inicio, fim).trim().replace(/\/\*\* Chave[\s\S]*$/, '').trim()})`, {
    obterToken: async () => token, baseUrl: () => 'https://teste.invalid',
    erroDeRedirecionamento: () => null,
    fetch: async () => { requests++; return { status: 500,
      text: async () => JSON.stringify({ ok: false, motivo: 'sem_identidade' }) }; },
  });
  const local = await chamar('/v1', {});
  assert.equal(local.preWriteLocal, true);
  assert.equal(requests, 0);
  token = 'falso';
  const remoto = await chamar('/v1', {});
  assert.equal(remoto.preWriteLocal, undefined);
  assert.equal(requests, 1);
});

# Fase 0.6D.3B — checkpoint local de 2026-09-21

Estado: **reconstrução e implementação concluídas e testadas localmente;
GO PARA O PRÓXIMO CHECKPOINT DE BUILD LOCAL. Piloto operacional ainda não autorizado.**

## Proveniência

- Repositório: `C:/Users/Yoga/Desktop/sistema-vargas/vargasnexus-pdv`.
- Branch: `codex/0.6d.3b-venda-v1`.
- HEAD inicial e origin/main após fetch: `97312d9c8f6643e6f107fd1dc94df431ee32b2e4`.
- Relação inicial: 0 ahead / 0 behind.
- Working tree inicial: nenhum rastreado alterado; somente `AGENTS.md` e
  `PROMPT-CORRECOES.md` untracked. Ambos foram preservados.
- HEAD após reconstrução: `ea8ad6d7c9222abcbca6b4e6702b652813e4d78f`.
- Relação final com origin/main: 7 ahead / 0 behind. A implementação nova da
  0.6D.3B permanece como alterações locais, sem commit próprio.
- Nenhum merge, push, release, rollout, instalação, venda real ou acesso a
  produção foi realizado. Nenhuma dependência foi instalada.

Hashes SHA-256 dos arquivos preexistentes, iguais antes e depois:

| Arquivo | SHA-256 |
|---|---|
| AGENTS.md | `DB35603BB4CBB17E3C656CD64E2E6B10474098928883FCCF20C39267474459EF` |
| PROMPT-CORRECOES.md | `9C4156AC19FBC96563B725C7D14B3F2E9077E74EB7FFA2B8050FA2AA6953AC45` |

## Reconstrução seletiva e dependências

A branch autorizada não continha V1, 0.6D.1 ou 0.6D.3A. A outra cadeia partia
de `1a52879`; a main inicial continha ainda `4a5f953` (classificação de devolução)
e `97312d9` (montagem de orçamento no caminho legado).

| Origem | Cherry-pick nesta branch | Necessidade |
|---|---|---|
| 94f6a70 | f964074 | 0.6D.1: exclusão na finalização e drenagem da fila |
| 3516c66 | 39d009c | Versão histórica 1.10.2, pré-requisito do patch de versão V1 |
| cc113bf | 4a39ece | Prova de registro e estoque no SQLite real |
| 6a756ba | 923269a | Correção da versão raiz do lockfile |
| 16ff5ac | f4a6888 | Reprodução executável das falhas de reenvio legado |
| 14c0242 | 85093c7 | Cliente V1, payload, coluna de protocolo e testes |
| ec49d12 | ea8ad6d | Gate de edição 0.6D.3A e provas SQLite |

Autoria, mensagens e ordem preservadas por cherry-pick. Não houve conflitos
de aplicação. A combinação foi revisada semanticamente. `api.js` permaneceu
idêntico ao blob da main inicial (`66833fc76ecec610f346deb228794bccb52ef96f`), e
`sync.js` preserva a reexportação de `api.montarPayloadOrcamentoRemoto`.

`450ef48` NÃO foi incorporado. Foi usado como referência para localizar
defeitos: o gate omitindo `negociando_v1`, a aceitação de motivos sem comprovar
o envelope, a falta de exclusão por venda entre fila/retry manual e o desvio
da recuperação diretamente ao legado.

## Causa raiz confirmada

Em `14c0242`, `_flagVendaV1()` lia
`store.get('terminal.rotas_habilitadas') || {}`. O terminal não persiste essa
configuração; a flag ausente selecionava legado para vendas novas.

Essa implementação existia na outra cadeia, não no checkout inicial.
A reconstrução reproduziu a base correta antes de aplicar a correção.

## Contrato server-side inspecionado

Foi consultado somente o objeto Git local do repositório `pdv-vargas-web`,
commit `fa1ae83e8400848d57877cc2f6ae1e1ab0599377`, incluindo a rota V1,
`operacaoProtegida`, `autenticarTerminal`, `decidirAcesso` e a migration
`20260915120000_venda_transacional_idempotente_v1.sql`.

O teste executa as funções TypeScript daquele commit com dependências
substituídas. A flag `vendas_transacional_v1` desligada retorna HTTP 409 antes
de reservar `pdv_operacoes` e antes da RPC ou dos efeitos comerciais da venda.
Há uma escrita de heartbeat em `pdv_terminais.ultima_atividade_em` dentro da
autenticação. Portanto, a evidência é **zero efeitos da venda**, não zero
escritas de qualquer natureza. Nenhum servidor implantado foi consultado.

`sem_identidade` nasce no terminal, antes do fetch da operação. Uma marca
local explícita distingue essa condição de um corpo remoto com o mesmo texto.

## Solução e semântica final

| Estado local | Comportamento |
|---|---|
| NULL | Persistir `negociando_v1` e `sync_payload_v1` juntos no mesmo UPDATE condicional; verificar `changes=1`; só então enviar V1 |
| Primeira tentativa recebe recusa pre-write comprovada | Persistir `legado` condicionalmente antes de executar o caminho legado |
| Primeira tentativa recebe qualquer outro resultado | Vincular a V1; interpretar sucesso, conflito ou pendência |
| `negociando_v1` após exceção/restart | Promover para V1; jamais renegociar/fazer fallback |
| `v1` | Retry exclusivamente V1, independentemente da flag posterior |
| `legado` | Permanecer no legado, independentemente da flag posterior |
| V1/negociação com snapshot ausente ou inválido | Bloquear antes de rede; não remontar pelos dados atuais, não alterar binding e não executar legado |
| Valor desconhecido | Bloquear sincronização e alteração; não interpretar como venda nova |

Uma resposta perdida ou exceção pode deixar `negociando_v1` persistido:
isso é intencional e conserva o binding V1 no restart. A recusa posterior de
uma tentativa NÃO prova ausência de efeito de uma tentativa anterior.

A recusa inicial para legado exige `sem_identidade` com prova de origem local,
ou `rota_desligada` com HTTP 409 e corpo coerente. Texto de motivo sozinho,
5xx, timeout, rede e respostas desconhecidas não autorizam legado.

Outras proteções inseparáveis da negociação:

- Fila, retry manual e recuperação compartilham single-flight por UUID.
- UPDATEs condicionais bloqueiam transições quando outra execução promoveu
  o binding; nenhuma chamada é enviada se a persistência falhar.
- Recuperação sem fila usa o mesmo caminho de arbitragem e protocolo.
- Arbitragem orçamento/venda continua antes dos efeitos da venda.
- Edição e cancelamento são recusados para V1/negociação/estado desconhecido
  sem confirmação remota; itens, estoque e fila permanecem intactos.
- Releitura após awaits evita enviar uma cópia anterior a uma edição ocorrida
  antes do binding.
- UUID da venda e IDs dos itens continuam os locais.
- Payload congelado no primeiro envio: retries leem exclusivamente o snapshot,
  sem remontagem pelo catálogo, cliente ou operador atual.
- A arbitragem de um retry usa o UUID remoto do orçamento no snapshot.
- Migration SQLite aditiva e nullable, verificada por PRAGMA; falhas não são
  mascaradas como coluna já existente. Testada somente em bancos temporários.
- Corpos HTTP de erro não são interpretados como prova de sucesso.

## Crash windows exercitadas

Subprocessos encerrados com `process.exit(77)`, SQLite em arquivo e retomada
por nova instância do sync, sem executar finally/fechamento normal no filho:

1. Antes do binding: NULL, nova negociação permitida, nenhum request anterior.
2. Após binding e antes do request: conservadoramente V1, sem fallback.
3. Durante envio: V1 após restart.
4. Após efeito remoto simulado e antes da resposta: V1; replay com mesmo UUID
   e payload persistido, resposta `ja_aplicada`, zero legado.
   Os testes adicionais alteram produto, cliente e contexto do operador,
   reabrem o banco e verificam replay idêntico ao snapshot original.
5. Após gravar V1 e antes de marcar synced: retry V1.
6. Após marcar synced: nenhum novo envio.
7. Após recusa pre-write mas antes de gravar legado: V1 conservador no restart.
8. Após gravar legado e antes de enviar legado: retry somente legado.

Não são provas de perda de energia, falha física do disco, concorrência de
Postgres ou commit remoto real. O efeito remoto do cenário 4 é um recibo
persistido por servidor falso, não uma venda real.

## Testes

| Etapa | Resultado |
|---|---|
| Base reconstruída: `npm.cmd test` | 252 testes aprovados |
| Base reconstruída: Electron `--test` duplo-registro-sqlite + edicao-venda-v1 | 12 aprovados no SQLite nativo |
| Rodada intermediária: negociação + contrato + V1 + arbitragem | 92 aprovados |
| Rodada final, com snapshot: `npm.cmd test` | 301 aprovados, zero falhas |
| Rodada final, com snapshot: Electron `--test` nas seis suítes abaixo | 121 aprovados, zero falhas, zero skips |
| Snapshot + negociação + V1 + arbitragem, antes da suíte completa | 109 aprovados |
| `node --check` nos quatro módulos alterados | Aprovado |
| `git diff --check` | Aprovado |

As seis suítes Electron: `duplo-registro-sqlite`, `edicao-venda-v1`,
`negociacao-protocolo`, `venda-v1-protocolo`, `execucaoUnica` e
`travas-concorrencia-local`.

O Node 24 não carrega o better-sqlite3 compilado para Electron. Duas suítes
históricas pulam nesse runtime e geram testes informativos de skip, apesar do
resumo do runner dizer zero skipped. Foram executadas efetivamente no Electron
(Node 20/ABI 121). Os novos testes usam SQLite real do Node com adaptação da
API quando necessário e também passam com better-sqlite3 nativo no Electron.
Não somar as contagens como testes únicos: há sobreposição entre runtimes.

Logs locais: `%TEMP%/pdv-base-tests.log`, `pdv-base-electron-out.log`,
`pdv-relevantes.log`, `pdv-completa.log`, `pdv-final-electron-out.log`.

## Arquivos da implementação nova

- `src/main/protocoloVenda.js`: estados, prova de recusa, gate compartilhado e leitura/validação do snapshot.
- `src/main/sync.js`: negociação persistida, CAS, exclusão por venda,
  recuperação unificada, snapshot antes do envio e interpretação conservadora de erro.
- `src/main/database.js`: gate compartilhado na edição/cancelamento e migration local `sync_payload_v1 TEXT`.
- `src/main/terminal.js`: prova local de ausência de request.
- `tests/venda-v1-protocolo.test.js`: contrato atualizado, preservando testes negativos.
- `tests/negociacao-protocolo.test.js`: integração SQLite, falhas e concorrência.
- `tests/contrato-v1-prewrite.test.js`: contrato Web pinado e transporte local.
- `tests/helpers/venda-sync.js` e `tests/helpers/crash-venda.js`: isolamento e processos de crash.
- `package.json` e `package-lock.json`: versão preparada `1.10.5`.
- Este relatório.

## Revisão crítica e fechamento do bloqueador

O risco foi reproduzido antes da correção: após resposta perdida, alterar
`produtos.remote_id` modificava o produto do payload de retry. O fingerprint
inspecionado no servidor inclui esse campo. Cliente/operador ficam fora do
fingerprint, mas também são preservados no snapshot para manter o conteúdo
da operação original.

O usuário autorizou explicitamente `sync_payload_v1` no SQLite local.
A implementação agora grava o JSON completo no mesmo UPDATE que faz
NULL -> negociando_v1. Sem dois commits locais separados, não há janela
com binding persistido e snapshot novo ainda não persistido.

O envio, incluindo a primeira tentativa, lê esse JSON. Não há regravação do
snapshot no retry. Ele é conservado após sucesso e após recusa que vinculou
a venda ao legado; nesse último caso, não é usado pelo caminho legado.

Testes verificam igualdade do payload depois de mudanças em produto, cliente,
empresa/depósito/operador do store e reabertura do SQLite. Isso prova o payload
emitido pelo cliente; não altera a autoridade da empresa do token no servidor.
Falha ao persistir snapshot preserva protocolo e snapshot nulos e não envia.
Migration sobre schema sem a coluna e reaplicação em schema atualizado também
foram exercitadas em SQLite real nos dois runtimes.

**Vendas antigas já V1/negociando_v1 sem snapshot:** ficam bloqueadas antes
até da arbitragem, com erro `snapshot_v1_invalido`. Não se inventa um snapshot
com o estado atual: pode haver commit remoto de conteúdo diferente. Exigem
reconciliação explícita em checkpoint posterior. O gate continua impedindo
edição/cancelamento. JSON corrompido ou identidade incompatível segue a mesma
política, sem fallback, substituição do snapshot ou alteração do binding.

Nenhum banco operacional foi aberto. A migration será aplicada pelo aplicativo
quando uma versão contendo a alteração inicializar um banco; nesta sessão,
somente bancos temporários de teste passaram por ela.

Outros limites:

- Contrato implantado, identidade e flag atuais do YOGA não verificados.
- Sem prova de concorrência real de transações Postgres nesta sessão.
- Problemas históricos de edição reconciliada/estoque remoto e legado parcial
  continuam fora do escopo; os testes históricos não foram removidos.
- Rollback para binário antigo que não conhece `negociando_v1` não é seguro
  enquanto houver operações pendentes nesse estado.
- `synchronous=NORMAL` é configuração existente; os testes cobrem crash de
  processo, não durabilidade contra perda de energia.

## Versão e próximo checkpoint

Versão preparada: **1.10.5**, pois 1.10.4 já identifica outra implementação.
Sem build, instalador, hash de artefato ou validação de app.asar nesta sessão.
Nenhuma instalação/publicação foi feita.

**GO PARA O PRÓXIMO CHECKPOINT DE BUILD LOCAL**, com versão 1.10.5 e
`--publish never`. Ainda não há prova do instalador/app.asar. Piloto operacional
exige checkpoint próprio para validar artefato, contrato implantado, UUID/flag
do YOGA e ausência ou reconciliação de vendas V1 antigas sem snapshot.
Nenhuma dessas ações foi executada automaticamente.

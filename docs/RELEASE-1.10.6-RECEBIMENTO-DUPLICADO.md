# Release 1.10.6 — trava contra recebimento duplicado

**Estado: preparado e testado; build NÃO gerado.** 25/09/2026.

## Por que sozinho

É a única correção pendente com dano ativo. Medido em produção nesta data:
**9 pares duplicados, R$ 737,91 em lançamentos excedentes**, o mais recente
em 22/09 — três dias antes deste checkpoint.

E é o release mais barato possível: `54aebd4` nasce de `97312d9`, que é
exatamente o binário que os quatro terminais da loja rodam (1.10.1). O delta
é `src/main/api.js` (14 linhas) mais um arquivo de teste. Não toca
`database.js`, `sync.js`, o caminho de venda nem qualquer flag.

## Proveniência

| | |
|---|---|
| worktree | `.claude/worktrees/release-recebimento` |
| branch | `release/1.10.6-recebimento-duplicado` |
| base | `97312d9` (= o que a loja roda) |
| correção | `54aebd4` (sessão Claude Sonnet 5, 24/09) |
| release | `6b69eed` (bump 1.10.6) |

O checkout de `codex/0.6d5-guarda-recebimento-duplicado` ficou intacto.

## O defeito corrigido

`pagarContaReceber()` e `pagarContaReceberParcial()` nunca checavam
`status='recebido'` antes de gravar. A lista local do caixa só atualiza no
sync: uma conta já quitada pelo site (ou por outro terminal) continuava
aparecendo pendente, e um clique em "Receber" gravava um SEGUNDO
`recebimentos` do mesmo valor — sem nada em `contas_receber` acusar, porque
ela já estava corretamente `recebido`. Inflava o "pago" no extrato do
cliente no sistema web.

Ambas agora retornam `{ ok: true, jaEstavaPago: true }` sem tocar em nada.

## Por que 1.10.6

Só `v1.10.1` está tagueada. 1.10.2 e 1.10.5 nunca viraram tag, mas
identificam builds ad-hoc **já instalados**: 1.10.2 no Escritório Silvano,
1.10.5 no YOGA. Reusar qualquer uma faria duas implementações diferentes
responderem pelo mesmo número — o problema que a 0.6D.3B já havia evitado ao
escolher 1.10.5 em vez de 1.10.4.

## ⚠️ ESTE BUILD NÃO CONTÉM A 0.6D.3B

Instalar em um terminal que roda 1.10.5 seria **downgrade funcional**:
removeria a negociação de protocolo e o snapshot V1 congelado. O YOGA tem
`vendas_transacional_v1` LIGADA e uma venda pendente vinculada a V1 com
snapshot em `sync_payload_v1` — coluna que o código de 1.10.6 não conhece.

**Destino: os quatro terminais em 1.10.1** (PDV-001, PDV-003, PDV-004,
Caixa). **NÃO instalar no YOGA.** O Escritório Silvano (1.10.2) precisa de
verificação própria antes.

## Testes

| | |
|---|---|
| Node (`npm test`) | **186/186**, zero falhas |
| Electron — suíte da correção | **4/4** |
| Electron — suíte completa | 99/104 |

As 5 falhas sob Electron são as suítes de orçamento, por
`ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` — o Electron 29 roda Node 20.9 e
esse builtin é do Node 22+. Limitação preexistente do harness, idêntica na
base `97312d9`, e as cinco passam sob Node 24. Não é regressão.

## Pendente

1. **Build não gerado** — `electron-builder --win --x64 --publish never` foi
   recusado pelo classificador do modo automático.
2. Sem hash de artefato, sem validação de `app.asar`.
3. Sem tag, sem push.
4. `empresa_config_pdv.versao_minima_pdv` não pôde ser lido (mesma recusa);
   convém conferir antes de atualizar terminal.
5. Rollout: um terminal primeiro, observar, depois os demais.

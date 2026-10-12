# Homologação da venda transacional V1 — terminal YOGA

**11–12/10/2026. GO.** Primeira venda aplicada pela rota transacional em
produção, e primeira prova real do cenário de resposta perdida.

Nenhum terminal da loja foi tocado. Tudo aconteceu no YOGA, que é terminal
próprio e estava fora da operação.

## Por que só agora

A rota `/api/pdv/vendas/sincronizar-v1` existia desde setembro, mas **só na
branch local** `codex/0.6d.3b-server-route-local`. Nunca tinha sido
publicada.

Isso causou o incidente de 09/10: a 1.10.7 foi instalada nos quatro
terminais da loja dependendo dessa rota; eles recebiam **404**, e 404 não é
recusa comprovada pré-escrita — então o contrato, corretamente, segurava a
venda em vez de reenviar por outro caminho. **29 vendas ficaram retidas por
duas horas**, recuperadas íntegras no downgrade para 1.10.6, sem duplicata e
sem buraco na numeração.

A rota foi publicada em 09/10 (PR #35, `a635041`) e **verificada em
produção** antes de qualquer nova instalação:

| requisição | resposta |
|---|---|
| `/api/pdv/vendas/sincronizar-v1` | **401** `sem_token` — existe |
| `/api/pdv/impressao` (controle) | 401 — mesmo comportamento |
| rota inventada (controle) | **404** |

## Preparação do terminal

O YOGA tinha a venda nº 100015 (R$ 3,00, 21/09) presa em
`sync_protocolo='v1'` sem `remote_id` — um teste da 0.6D.3B que nunca
chegou ao servidor. Com a rota publicada e a flag dele ligada, ela
sincronizaria sozinha ao religar o terminal, tirando 15 unidades de BUCHA
TRIFIX 8 do estoque real com data de três semanas atrás.

Foi **neutralizada antes de abrir**, com backup do banco (hash conferido) e
sem apagar nada: `status='cancelada'` — valor que a varredura de recuperação
exclui — mais observação explicando o motivo, e devolução das 15 unidades ao
estoque local. O `sync_protocolo='v1'` ficou, como registro honesto de que
ela chegou a ser vinculada.

Verificado depois de abrir: `pdv_venda_sync` em 0, venda ausente no
servidor, estoque em 813 — intacto.

## A primeira venda transacional

Venda **nº 100016**, R$ 1,50, dinheiro, 1 item. Aplicada às 01:11:08.

| verificação | resultado |
|---|---|
| estado | `aplicada` |
| `schema_version` | **1** — o v2 não liga sozinho |
| `fingerprint_pagamentos` | nulo, coerente com v1 |
| itens | 1 declarado, 1 gravado |
| estoque | `aplicado=true`, **1** movimento |
| `pdv_operacoes` | `vendas.sincronizar_v1/sucesso`, v1.10.7 |
| duplicatas | 0 |

`pdv_venda_sync` foi criada em 15/09 e esperou quase um mês por esta linha.

### A composição local de pagamentos funcionou junto

`venda_pagamentos` no SQLite ganhou 1 linha, gerada pelo adaptador a partir
da forma única que a UI manda:

```
forma=dinheiro · valor=1.50 · valor_entregue=1.50 · troco=0 · sequencia=1
```

Entregue e troco preenchidos porque é espécie — exatamente a regra. E no
servidor `venda_pagamento` continuou em **0**: a composição local existe, o
protocolo segue v1. Estrutura nova não é protocolo novo ativado.

## O teste que importava: resposta perdida

É o cenário que originou a fase 0.6D inteira — o servidor aplica, o terminal
não fica sabendo, e o retry não pode virar venda duplicada.

Reproduzido com fidelidade: com o PDV fechado, `remote_id` foi limpo e
`sync_status` voltou a `pending`. O `sync_protocolo='v1'` e o snapshot de 856
bytes ficaram intactos — o reenvio manda o payload original, byte a byte.

Ao reabrir, a varredura reenviou às 01:20:40:

| | antes | depois |
|---|---|---|
| `pdv_venda_sync` | 1 | **1** |
| vendas do YOGA | 1 | **1** |
| itens | 1 | **1** |
| movimentos de estoque | 1 | **1** |
| `aplicado_em` | 01:11:08 | **01:11:08** |

**Nada foi escrito.** O `aplicado_em` inalterado é a prova mais limpa: a
linha é a original, o segundo envio só consultou. O terminal se reconciliou
sozinho — `remote_id` de volta, `synced_at` 01:20:40.

A operação não aparece em `pdv_operacoes` porque `ja_aplicada` retorna antes
de reservar a chave de idempotência — a mesma ordem que os testes do PR #35
garantem.

## O que isto valida

- a rota V1 publicada, ponta a ponta, em produção
- a RPC `sincronizar_venda_pdv_v1`: venda, itens e estoque numa transação
- o contrato da 0.6D.3B: negociação, snapshot congelado, binding permanente
- a tabela local `venda_pagamentos` do Checkpoint 2 da 4C.2
- **idempotência sob resposta perdida, com dinheiro e estoque reais**

Estava tudo provado em teste desde setembro. Agora está provado em produção.

## O que NÃO foi validado

- **o protocolo v2.** A composição v2 existe no cliente mas está desligada
  por padrão, e não há interface que a ligue — `montarPayloadVendaV1` só
  compõe com `ctx.pagamentosV2 === true`, e ninguém passa isso. A UI de
  múltiplos pagamentos não começou. O v2 segue provado apenas em transação
  revertida (11 cenários, 09/10).
- **a carteira via `venda_pagamento`** (parte B do Checkpoint 3), pelo mesmo
  motivo.
- **concorrência real** entre dois terminais na mesma venda.
- **a Fase 4E**: `caixa_movimento` continua em 13. Nenhum centavo de venda
  entra na gaveta ainda.

## Estado ao fim

| Terminal | Versão | Flag V1 |
|---|---|---|
| Balcão 02 · 03 · 04 · Caixa · Escritório | 1.10.6 | desligada |
| **YOGA** | **1.10.7** | **ligada** |

`venda_pagamento` 0 · `caixa_movimento` 13 · 0 clientes com saldo divergente.

A venda nº 100016 (R$ 1,50) é real no sistema. Pode ser cancelada pelo ERP
web para estornar o item, ou deixada como marco da homologação.

## Para levar a 1.10.7 à loja

Agora é possível — a armadilha de 09/10 não existe mais. Mas com ordem:

1. um terminal por vez, do menor volume para o maior (PDV-004 → Caixa →
   PDV-001 → PDV-003)
2. instalação **e** flag juntas: com a flag desligada, uma venda feita
   offline fica presa, porque erro de rede não é recusa comprovada e o
   binding V1 é permanente
3. conferir `pdv_venda_sync` crescendo e nenhuma venda sem `remote_id` por
   mais de alguns minutos
4. observar antes do próximo

E continua valendo: **não publicar Release no GitHub**. Ver
`docs/COORDENACAO.md`.

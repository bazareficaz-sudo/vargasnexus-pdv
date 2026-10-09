# Roteiro do piloto — 1.10.7 no Balcão 04 (PDV-004)

Instalação manual, um terminal. **Não publicar Release no GitHub**: o
`electron-updater` tem `autoDownload` e `autoInstallOnAppQuit` ligados e
entregaria a versão a todos de uma vez.

## ⚠️ ESTE RELEASE NÃO É COMO O DA 1.10.6

A 1.10.6 era `main` + 14 linhas em `api.js`, sem mudança de schema, com
rollback trivial. A 1.10.7 é outra coisa:

| | 1.10.6 | 1.10.7 |
|---|---|---|
| arquivos de código | 1 | 8 |
| schema local | nenhuma mudança | **3 alterações** |
| renderer | intocado | `pdv.js`, `index.html`, `execucaoUnica.js` |
| rollback | reinstalar e pronto | **porta de mão única** (abaixo) |

Schema que ela aplica no SQLite: `vendas.sync_protocolo`,
`vendas.sync_payload_v1` e a tabela `venda_pagamentos`. Todas aditivas.

## A DESCOBERTA QUE MUDA O PLANO

**Instalar a 1.10.7 com a flag `vendas_transacional_v1` desligada NÃO é
seguro.**

O cliente da 0.6D.3B **sempre negocia**: toda venda nova grava
`sync_protocolo='negociando_v1'` e o snapshot ANTES de enviar, qualquer que
seja a flag. Só a primeira tentativa pode cair para o legado, e só mediante
**recusa comprovada pré-escrita** (HTTP 409 coerente).

Um erro de rede não é recusa comprovada. Então uma venda feita **offline**:

1. grava `negociando_v1`, tenta enviar, falha por rede → continua `negociando_v1`
2. na execução seguinte é **promovida a `v1`**, em definitivo
3. V1 responde `rota_desligada` → o contrato mapeia para **pendente**, jamais legado
4. repete para sempre

Isso é intencional — é o que impede venda duplicada — e está **provado nos
testes** da 0.6D.3B (`resposta ambígua não libera legado`, que exercita
`motivo: 'rede'` e `'timeout'` e termina com a rota desligada: só chamadas
`v1`, nunca legado).

**Consequência prática:** numa loja com internet intermitente, instalar a
1.10.7 sem ligar a flag deixaria vendas presas. A instalação e a flag têm de
andar juntas.

## Rollback é porta de mão única

Enquanto **nenhuma venda tiver sido aplicada por V1**, voltar para a 1.10.6 é
seguro: a rota recusa antes de qualquer efeito, e as colunas novas no SQLite
são aditivas e ignoradas pelo binário antigo.

**Depois da primeira venda aplicada por V1, não é.** A 1.10.6 não conhece
`sync_protocolo` nem `sync_payload_v1`. Uma venda vinculada a V1 sem
`remote_id` seria reenviada pelo caminho legado — e se a tentativa V1 tiver
commitado no servidor, nasce **venda duplicada**. É exatamente o cenário que
a 0.6D.3B existe para impedir, e que o YOGA representa hoje.

Por isso: decidir o rollback **cedo**, pela observação do piloto, não depois
de um dia de operação.

## Artefato

| | |
|---|---|
| arquivo | `dist/VargasNexus PDV Setup 1.10.7.exe` |
| tamanho | 82.889.654 bytes |
| SHA-256 | `3c958be215e8f8f1d78fd0d1bb18fa2c904701440acc203119422269ff611a85` |
| Electron | 29.4.6 · better-sqlite3 12.10.1 |

Conferido dentro do `app.asar`: versão **1.10.7**; `protocoloVenda.js`,
`payloadVendaV1.js` e `pagamentoVenda.js` presentes; marcadores
`venda_pagamentos`, `sync_payload_v1`, `negociando_v1`, `completada_v2`,
`conflito_pagamentos` e **`jaEstavaPago`** — este último confirma que a
correção da 1.10.6 veio junto, sem regressão.

Conferir o hash no terminal antes de executar:

```
Get-FileHash "C:\caminho\VargasNexus PDV Setup 1.10.7.exe" -Algorithm SHA256
```

Não assinado: o SmartScreen vai avisar.

## Testes

Node **378/378**. Electron **199 passam, 1 skip** — o teste de contrato Web,
que exige `stripTypeScriptTypes` (ausente no Node 20.9 do Electron). Skip
preexistente e documentado.

## Sequência do piloto

Fim de expediente, com a fila sincronizada e nenhuma venda em aberto.

1. **Backup do banco**, com o PDV fechado:
   ```
   Copy-Item "$env:APPDATA\pdv-vargas\pdv-vargas.db" "$env:USERPROFILE\Desktop\pdv-backup-antes-1.10.7.db"
   ```
   Aqui o backup **não é opcional**, ao contrário da 1.10.6: o schema muda.

2. **Instalar** como administrador, mantendo o diretório existente.

3. **Ligar a flag para ESTE terminal**, e só ele:
   ```sql
   UPDATE pdv_terminais
      SET rotas_habilitadas = coalesce(rotas_habilitadas,'{}'::jsonb)
                              || '{"vendas_transacional_v1": true}'::jsonb
    WHERE terminal_id_legado = 'PDV-004';
   ```

4. **Abrir o PDV** e conferir que mostra 1.10.7.

## Verificação

**No terminal:** abre, faz login, a carteira carrega, uma venda de teste de
valor baixo finaliza.

**No servidor**, logo depois da venda de teste:

```sql
SELECT versao_pdv, rotas_habilitadas FROM pdv_terminais
 WHERE terminal_id_legado = 'PDV-004';

SELECT venda_id, estado, schema_version, itens, estoque_aplicado
  FROM pdv_venda_sync ORDER BY aplicado_em DESC LIMIT 3;
```

Esperado: `versao_pdv = '1.10.7'`, a flag ligada, e **a primeira linha de
`pdv_venda_sync` da história** — estado `aplicada`, `schema_version` 1.

Essa linha é o marco: até agora a tabela tem **zero** registros, porque a
rota V1 nunca aplicou uma venda em produção.

**`schema_version` deve ser 1**, não 2: a composição v2 está desligada por
padrão no cliente. Se vier 2, algo ligou o que não devia.

## Observação nas 24h

- `pdv_venda_sync` cresce junto com as vendas do PDV-004
- nenhuma venda com `remote_id` nulo por mais de alguns minutos
- `venda_pagamento` continua **0** (v2 desligado)
- `caixa_movimento` continua 13
- volume de vendas do PDV-004 no normal (~40/semana)

Uma venda parada com `sync_protocolo='v1'` e sem `remote_id` por mais de uma
hora é o sinal de alarme — significa que o V1 não está concluindo.

## Depois

Com o PDV-004 estável por alguns dias, repetir nos demais, um por vez, do
menor volume para o maior: Caixa → PDV-001 → PDV-003. **Cada um com a flag
ligada junto.**

O Escritório Silvano e o YOGA ficam por último e têm conversa própria — o
YOGA já roda 1.10.5 com a flag ligada e tem a venda `78dc3e07…` pendente em
`sync_protocolo='v1'`, que precisa ser reconciliada antes de qualquer coisa.

A composição v2 (`pagamentosV2`) continua **desligada** e só entra depois de
o V1 estar estável em toda a frota.

# Roteiro do piloto — 1.10.6 no Balcão 04 (PDV-004)

Instalação **manual**, um terminal só. Não publicar release no GitHub: o
`electron-updater` tem `autoDownload` e `autoInstallOnAppQuit` ligados e
checa 15s depois de abrir o app — publicar entregaria a versão a **todos**
os terminais de uma vez, inclusive ao YOGA, que não pode recebê-la.

## O que torna este piloto barato

`src/main/database.js` é **byte a byte idêntico** ao da 1.10.1. O delta da
versão é `src/main/api.js` (14 linhas) e um teste.

Consequências práticas:

- **nenhuma migration roda**; o schema do SQLite não muda;
- o banco em `%APPDATA%\pdv-vargas\pdv-vargas.db` fica intacto — o
  instalador escreve em `C:\Program Files`, não no perfil do usuário;
- **rollback é reinstalar a 1.10.1 e pronto**, sem conversão de dados.

## Artefato

| | |
|---|---|
| arquivo | `VargasNexus PDV Setup 1.10.6.exe` |
| tamanho | 82.883.026 bytes |
| SHA-256 | `25ecdf0e63cd1ccf3b1dff2d0f3c2308700b5f68510b492f0b8f8b91fc20de7c` |
| instalação | NSIS, `perMachine` (pede administrador), com assistente |

Conferir o hash **no terminal**, depois de copiar o arquivo, antes de
executar — é o que garante que o que chegou é o que saiu daqui:

```
Get-FileHash "C:\caminho\VargasNexus PDV Setup 1.10.6.exe" -Algorithm SHA256
```

Deve bater com `25ECDF0E...`. Se não bater, **pare**: a cópia corrompeu.

O instalador **não é assinado** — o Windows vai mostrar o aviso do
SmartScreen. É esperado: "Mais informações" → "Executar assim mesmo".

## Antes de instalar

1. **Escolher a hora**: fim do expediente, ou um momento sem fila de
   clientes. A instalação fecha o PDV.
2. **Fila de sincronização vazia.** Abrir o PDV, deixar sincronizar e
   confirmar que não há pendências. Se houver venda pendente, esperar
   subir. Instalar com fila cheia não perde dado (o banco não é tocado),
   mas mistura duas variáveis se algo der errado depois.
3. **Nenhuma venda em aberto na tela.**
4. **Anotar a versão atual** — deve ser 1.10.1.

### Backup do banco (2 minutos, vale a pena)

Com o PDV **fechado**:

```
Copy-Item "$env:APPDATA\pdv-vargas\pdv-vargas.db" "$env:USERPROFILE\Desktop\pdv-vargas-backup-antes-1.10.6.db"
```

Não é necessário pela natureza da mudança, mas é o seguro barato: se algo
inesperado acontecer, o estado exato de antes está guardado.

## Instalação

1. Fechar o VargasNexus PDV completamente.
2. Executar o instalador **como administrador**.
3. Manter o diretório de instalação que já existe (não mudar o caminho).
4. Concluir e abrir o PDV.

## Verificação — no terminal

1. O PDV abre normalmente e faz login.
2. A versão exibida é **1.10.6**.
3. Uma venda de teste, de valor baixo, finaliza e sincroniza.
4. A carteira de clientes carrega.

## Verificação — no servidor

Depois que o terminal abrir e bater heartbeat (até ~1 min), confirmar:

```sql
SELECT nome, versao_pdv, ultima_atividade_em
FROM pdv_terminais
WHERE terminal_id_legado = 'PDV-004';
```

Esperado: `versao_pdv = '1.10.6'` e atividade recente.

E que as vendas continuam entrando:

```sql
SELECT count(*), max(created_at)
FROM vendas
WHERE terminal_id = 'PDV-004' AND created_at > now() - interval '1 day';
```

## O teste que prova a correção

É o ponto do release, e só dá para exercitar com uma conta de carteira:

1. Escolher um cliente com conta **em aberto**.
2. **Quitar essa conta pelo site** (ERP web), não pelo PDV.
3. No PDV-004, **sem sincronizar**, abrir a Carteira de Clientes — a conta
   ainda aparece como pendente (é o cenário do defeito).
4. Clicar em **Receber**.

**Antes da correção**: gravava um segundo lançamento em `recebimentos`.
**Com a 1.10.6**: não grava nada; a operação é ignorada em silêncio.

Conferir no servidor que não nasceu linha duplicada:

```sql
SELECT conta_id, valor, count(*) AS lancamentos
FROM recebimentos
WHERE created_at > now() - interval '1 hour'
GROUP BY conta_id, valor
HAVING count(*) > 1;
```

Esperado: **zero linhas**.

## Observação nas 24h seguintes

- o terminal continua batendo heartbeat em 1.10.6;
- o volume de vendas do PDV-004 se mantém no normal (~38/semana);
- nenhum par duplicado novo em `recebimentos`.

## Rollback

Se qualquer coisa sair errada:

1. Baixar o instalador da **v1.10.1** em GitHub Releases
   (`bazareficaz-sudo/vargasnexus-pdv`, tag `v1.10.1`).
2. Instalar por cima, como administrador.
3. O banco não precisa ser restaurado — o schema nunca mudou. O backup só
   seria usado num cenário que não temos motivo para esperar.

O `electron-updater` **não** desfaz isso sozinho: ele só atualiza para
versão maior. Um terminal em 1.10.6 não é puxado de volta, e um em 1.10.1
não é empurrado para frente enquanto não houver release publicada.

## Depois do piloto

Com o PDV-004 estável, seguir na ordem de volume crescente, um por vez:
Caixa (2 vendas/semana) → Balcão 02 / PDV-001 (186) → Balcão 03 / PDV-003
(260).

**YOGA fica de fora.** Roda 1.10.5, com `vendas_transacional_v1` ligada e a
venda `78dc3e07…` (nº 100015, R$ 3,00) parada em `sync_protocolo='v1'` sem
`remote_id`. A 1.10.1/1.10.6 não conhece as colunas `sync_protocolo` nem
`sync_payload_v1`: instalar ali faria o binário antigo reenviar pelo caminho
legado uma venda que pode já ter sido aplicada no servidor — venda
duplicada, que é exatamente o que a 0.6D.3B existe para impedir.

**Escritório Silvano** (1.10.2) precisa de verificação própria antes:
descobrir de qual linhagem é aquele build, já que 1.10.2 nunca virou tag.

A publicação da release no GitHub — que abriria a atualização automática
para todos — só depois de os quatro terminais estarem em 1.10.6 e o YOGA
ter destino definido.

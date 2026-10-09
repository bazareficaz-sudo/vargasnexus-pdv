# Coordenação entre sessões — leia antes de mexer

Este repositório tem trabalho de várias sessões ao mesmo tempo. Já houve
atrito: checkout trocado no meio de uma execução, worktree removido. Nada se
perdeu porque estava em branch, mas custou tempo.

Estas regras existem para isso não repetir. Atualizado em 09/10/2026.

## Estado da frota

| Terminal | Versão | Rota V1 |
|---|---|---|
| Balcão 02 · 03 · 04 · Caixa · Escritório | **1.10.6** | desligada |
| YOGA (máquina de teste) | **1.10.5** | **ligada** |

`origin/main` está em **1.10.6** (`54d7209`) — igual ao que a loja roda.
Isso passou a ser verdade em 09/10; antes disso a `main` estava atrás.

## Parta sempre da `main`

Nunca de uma branch de fase. Elas carregam trabalho não publicado e, em
alguns casos, versões diferentes do que está instalado.

```
git checkout main && git pull && git checkout -b feat/sua-coisa
```

## Zona quente — avise antes de mexer

Estes arquivos são o miolo de sincronização de venda. A linha
`fase-4c2/pagamentos-locais` mexe em todos eles:

- `src/main/database.js`
- `src/main/sync.js`
- `src/main/protocoloVenda.js`
- `src/main/payloadVendaV1.js`
- `src/main/pagamentoVenda.js`
- `src/main/terminal.js`
- `src/renderer/index.html`
- `src/renderer/lib/execucaoUnica.js`

E, dentro de `src/renderer/pages/pdv.js` (2.561 linhas), **apenas o bloco de
finalização da venda**, por volta da linha 1700 — o momento de fechar a
venda e escolher a forma de pagamento. O resto do arquivo é livre.

Tudo o mais está livre: impressão (`print-server.js`, `main.js`,
`preload.js`), orçamentos (`orcamentos.js`, `orcamentoComando.js`,
`orcamentoSql.js`), carteira, entregas, marketplace, catálogo.

## Numeração de versão

Vá de **1.10.8 em diante**. **Pule a 1.10.7**: ela está reservada para a
linha de pagamentos e já existe como `.exe` no disco.

Nunca reutilize um número que já identifica um build instalado. Hoje já
existem builds distintos de 1.10.2 a 1.10.5 em linhagens paralelas, e isso
confundiu o dia inteiro.

## Antes de instalar qualquer versão

**Se o PDV passar a chamar uma rota nova do servidor, confirme que ela
responde em produção.** Um comando:

```
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "https://www.sistemavargas.com.br/api/pdv/SUA-ROTA" \
  -H "Content-Type: application/json" -d '{}'
```

- **401** = a rota existe (recusou por falta de token) — ok
- **404** = **não está no ar** — não instale

Isso não é zelo excessivo. Em 09/10 a 1.10.7 foi instalada nos quatro
terminais dependendo de uma rota que nunca tinha sido publicada. O terminal
recebia 404, e 404 não é recusa comprovada — então o contrato, corretamente,
segurava a venda em vez de reenviar por outro caminho. **29 vendas ficaram
retidas por duas horas.** Foram recuperadas íntegras no downgrade, sem
duplicata, mas o custo foi real.

## NÃO publique Release no GitHub

O `electron-updater` lê **Releases** (não tags, não branches) e tem
`autoDownload` e `autoInstallOnAppQuit` ligados. Publicar entrega a versão a
**todos** os terminais na próxima abertura — inclusive ao **YOGA**, que roda
1.10.5 com a rota V1 ligada e levaria um downgrade funcional.

Instale manualmente, um terminal por vez. A Release mais recente hoje é
**1.10.1**, menor que a frota — por isso ninguém atualiza sozinho.

Tag é inofensiva. Release não.

### A partir da 1.10.8: o servidor libera, terminal por terminal

A 1.10.8 só baixa uma Release até o teto em
`pdv_terminais.atualizacao_liberada_ate` (rota `GET /api/pdv/atualizacao`,
`sistema-vargas`). NULL — o padrão — é "não atualiza sozinho"; sem resposta do
servidor, também não. Liberar o piloto:

```sql
update pdv_terminais set atualizacao_liberada_ate = '1.10.9'
 where terminal_id_legado = 'PDV-004';
```

**A regra acima continua valendo até TODOS os terminais rodarem 1.10.8 ou
mais.** A trava só existe no código novo: um terminal em 1.10.6 (ou o YOGA em
1.10.5) ainda baixa qualquer Release maior. A 1.10.8 é a última instalação
manual; a linha de pagamentos (1.10.7) precisa trazer o mesmo `updater.js`.

## Rollout, quando for o caso

1. um terminal primeiro, o de menor volume (**PDV-004**, ~40 vendas/semana)
2. conferir no servidor: `pdv_terminais.versao_pdv` e vendas chegando
3. observar antes do próximo
4. ordem por volume crescente: PDV-004 → Caixa → PDV-001 → PDV-003

Rollback: o instalador da versão anterior está em
`.claude/worktrees/release-recebimento/dist/` (1.10.6). O `electron-updater`
só sobe de versão, então um terminal já atualizado não é puxado de volta.

## Branches em aberto (não mexa nelas)

| branch | o que é |
|---|---|
| `fase-4c2/pagamentos-locais` | V1 + pagamentos locais + cliente V2 (1.10.7, não publicada) |
| `release/1.10.6-recebimento-duplicado` | o que está instalado |
| `codex/0.6d.3b-venda-v1` | checkpoint histórico da 0.6D.3B — preservar o hash |

## Se precisar mexer na zona quente

Fale antes. O rebase da linha de pagamentos sobre o seu trabalho é problema
de quem mantém aquela linha, não seu — mas só funciona se der para saber o
que mudou.

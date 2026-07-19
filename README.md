# VargasNexus PDV — Terminal de Vendas Offline-First

Sistema PDV Desktop para Windows com sincronização bidirecional com Base44 (Sistema Vargas).

---

## ✅ Funcionalidades

- **Offline-first**: funciona 100% sem internet, sincroniza automaticamente quando a conexão volta
- **PDV completo**: busca por nome, SKU, EAN (leitor de código de barras), carrinho, múltiplas formas de pagamento
- **Clientes e crédito**: saldo de crédito, histórico de movimentações
- **Estoque local**: baixa automática ao vender, alertas de estoque mínimo
- **Sync bidirecional com Base44**: produtos, clientes, estoque, vendas, movimentações
- **Fila de sync**: operações offline enfileiradas e enviadas ao reconectar
- **Banco SQLite local**: otimizado para 14k+ produtos (índices, WAL mode, 32MB cache)
- **Cancelamento de vendas**: estorno de estoque local + sync

---

## 🚀 Instalação e execução

### Pré-requisitos
- **Node.js 18+** — https://nodejs.org
- **Git** (opcional)

### Passos

```bash
# 1. Entrar na pasta do projeto
cd vargasnexus-pdv

# 2. Instalar dependências
npm install

# 3. Executar em modo desenvolvimento
npm start

# 4. Gerar instalador Windows (.exe)
npm run build
```

O instalador gerado fica em `dist/VargasNexus PDV Setup.exe`.

---

## ⚙️ Configuração Base44

### 1. Primeiro acesso
Ao abrir o app pela primeira vez, a tela de login solicita:
- **App ID**: ID do seu projeto no Base44
- **Usuário / Senha**: credenciais do operador
- **Terminal ID**: identificador deste PDV (ex: `PDV-001`, `CAIXA-02`)

### 2. Variáveis no arquivo `src/main/api.js`
```js
const BASE44_CONFIG = {
  BASE_URL: 'https://api.base44.com/api/apps',
  APP_ID: 'SEU_APP_ID_AQUI',   // ← substitua
  API_SECRET: 'PDV_API_SECRET', // ← conforme fornecido
};
```

### 3. Backend Functions necessárias no Base44
Crie estas functions no painel do Base44 para o projeto Sistema Vargas:

| Function | Descrição |
|---|---|
| `pdvPing` | Verificar conectividade (retorna `{ok:true}`) |
| `pdvAutenticarTerminal` | Login — recebe `{usuario, senha}`, retorna `{token, usuario, empresa_id, deposito_id}` |
| `pdvSincronizarProdutos` | Recebe `{ultima_sincronizacao, empresa_id, deposito_id}`, retorna `{produtos:[...]}` |
| `pdvSincronizarClientes` | Recebe `{ultima_sincronizacao, empresa_id}`, retorna `{clientes:[...]}` |
| `pdvSincronizarEstoque` | Recebe `{ultima_sincronizacao, empresa_id, deposito_id}`, retorna `{estoque:[...]}` |
| `pdvRegistrarVenda` | Recebe payload completo da venda, retorna `{id: remote_id}` |
| `pdvCancelarVenda` | Recebe `{venda_id, motivo}`, retorna `{ok:true}` |
| `pdvRegistrarMovimentacaoEstoque` | Recebe movimentação, retorna `{id}` |

---

## 📁 Estrutura do Projeto

```
vargasnexus-pdv/
├── src/
│   ├── main/                   # Processo principal (Node.js)
│   │   ├── main.js             # Janela, IPC handlers, tray
│   │   ├── preload.js          # Bridge segura main ↔ renderer
│   │   ├── database.js         # SQLite — todas as queries
│   │   ├── api.js              # Cliente Base44 REST
│   │   └── sync.js             # Motor de sync offline-first
│   └── renderer/               # Interface (HTML/CSS/JS)
│       ├── index.html          # Entry point
│       ├── app.js              # Controller principal, routing
│       ├── styles/
│       │   ├── global.css      # Estilos globais
│       │   └── components.js   # Login, Produtos, Clientes, Vendas, Estoque, Config
│       └── pages/
│           └── pdv.js          # Frente de caixa (módulo mais complexo)
├── assets/
│   └── icon.png                # Ícone do app (adicione antes de buildar)
└── package.json
```

---

## 🗄️ Banco de dados local

Localização: `%APPDATA%\pdv-vargas\pdv-vargas.db`

Tabelas principais:
- `produtos` — catálogo local (14k+ produtos)
- `estoque` — quantidades por depósito
- `clientes` — cadastro + saldo de crédito
- `vendas` + `venda_itens` — histórico local
- `movimentacoes_estoque` — log de entradas/saídas
- `credito_movimentacoes` — histórico de crédito de clientes
- `sync_queue` — fila de operações pendentes para Base44

---

## 🔄 Lógica de sincronização

```
App abre
  └─ Tenta sync inicial (3s delay)
       ├─ Online  → baixa produtos/clientes/estoque atualizados
       │            → envia fila de vendas/movimentações pendentes
       └─ Offline → usa banco local, exibe indicador laranja

A cada 30s → verifica conectividade
A cada 5min → sync completo (se online)

Venda registrada (offline ou online):
  → Salva no SQLite imediatamente (nunca trava o operador)
  → Baixa estoque local
  → Enfileira na sync_queue
  → Quando online: envia para Base44 e salva remote_id
```

**Resolução de conflitos:**
- Produtos/Estoque/Clientes: servidor ganha (dados mestre no Base44)
- Vendas: local sempre ganha (PDV é fonte da verdade para vendas)

---

## ⌨️ Atalhos de teclado no PDV

| Tecla | Ação |
|---|---|
| `↑` / `↓` | Navegar resultados de busca |
| `Enter` | Adicionar produto selecionado |
| `Esc` | Fechar busca |
| Digitar EAN | Busca automática por código de barras |

---

## 📦 Build para Windows

```bash
npm run build
```

Gera em `dist/`:
- `VargasNexus PDV Setup 1.0.0.exe` — instalador NSIS

Para rodar sem instalar:
```bash
npm run build:dir
# Executável em dist/win-unpacked/VargasNexus PDV.exe
```

---

## 🔧 Adicionar ícone

Coloque um arquivo `assets/icon.png` (512×512px) antes de buildar.
O electron-builder converte automaticamente para `.ico` no Windows.

---

## 📞 Suporte

Sistema Vargas / Base44 — VargasNexus PDV Terminal v1.0

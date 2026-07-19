// ─── PDV — Frente de Caixa ────────────────────────────────────────
const PDV = (() => {
  let cart = [];
  let selectedClient = null;
  let searchTimeout = null;
  let payMethod = 'dinheiro';
  let valorPago = 0;
  let vendedorAtual = null; // { id, codigo, nome, comissao }
  let dadosEntrega = null;  // preenchido na etapa "Agendar Entrega"
  let modoEdicao = null;    // { vendaId, numero, remote_id } — null = venda nova
  let _ultimaVenda = null;  // { numero, remoteId, venda } — usado pelos botões do comprovante

  // ─── Render ────────────────────────────────────────────────────
  function render() {
    return `
<div class="pdv-layout">
  <!-- Coluna esquerda: busca + produto -->
  <div class="pdv-left">
    <div class="pdv-search-wrap">
      <input class="input input-lg pdv-search" id="pdv-search"
        placeholder="🔍  F2 · Nome, SKU ou EAN do produto..."
        oninput="PDV.onSearch(this.value)"
        onkeydown="PDV.onSearchKey(event)"
        autocomplete="off" autofocus>
      <div class="pdv-search-results" id="pdv-results" style="display:none"></div>
    </div>

    <!-- Painel de confirmação Qty/Preço -->
    <div id="pdv-qty-panel" style="display:none;flex-direction:column;gap:0;flex-shrink:0;border-bottom:1px solid var(--border);background:var(--bg2)">
      <div style="padding:10px 16px 0">
        <div id="qp-nome" style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
        <div id="qp-info" style="font-size:11px;color:var(--text3);margin-top:2px"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px 16px">
        <div>
          <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Quantidade</label>
          <input class="input" id="qp-qty" type="number" min="0.001" step="1" value="1"
            style="font-size:18px;font-weight:700;text-align:center"
            onkeydown="PDV.qpKeyDown(event,'qty')">
        </div>
        <div>
          <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Preço Unit. (R$)</label>
          <input class="input" id="qp-preco" type="number" min="0" step="0.01"
            style="font-size:18px;font-weight:700;text-align:center;${podePermissao('alterar_preco_venda') ? '' : 'opacity:.45;pointer-events:none'}"
            ${podePermissao('alterar_preco_venda') ? '' : 'readonly'}
            onkeydown="PDV.qpKeyDown(event,'preco')">
        </div>
      </div>
      <div style="display:flex;gap:8px;padding:0 16px 10px">
        <button class="btn btn-ghost btn-sm" style="flex:1" onclick="PDV.fecharQtyPanel()">ESC · Cancelar</button>
        <button class="btn btn-primary" style="flex:2" onclick="PDV.confirmarQtyPreco()">↵ Enter · Adicionar ao Carrinho</button>
      </div>
    </div>

    <!-- Cliente selecionado -->
    <div class="pdv-client-bar" id="pdv-client-bar">
      <span class="text-muted" style="font-size:12px">👤 Sem cliente</span>
      <button class="btn btn-ghost btn-sm" onclick="PDV.openClientSearch()">+ Selecionar</button>
    </div>

    <!-- Banner modo edição -->
    <div id="pdv-edicao-banner" style="display:none;align-items:center;justify-content:space-between;
      background:#b45309;color:#fff;padding:8px 16px;font-size:12px;font-weight:600;flex-shrink:0">
      <span id="pdv-edicao-label">✏️ Editando Venda</span>
      <button onclick="PDV.cancelarEdicao()" style="background:rgba(0,0,0,.25);border:none;color:#fff;
        padding:3px 10px;border-radius:4px;cursor:pointer;font-size:11px">✕ Cancelar Edição</button>
    </div>

    <!-- Badge entregas -->
    <div id="pdv-entrega-badge" style="display:none;align-items:center;
      background:var(--accent-bg);border-top:1px solid var(--accent);
      padding:6px 16px;font-size:12px;color:var(--accent);font-weight:600;
      flex-shrink:0"></div>

    <!-- Itens do carrinho -->
    <div class="pdv-cart" id="pdv-cart">
      <div class="empty-state" style="padding:30px 0">
        <div class="icon">🛒</div>
        <h3>Carrinho vazio</h3>
        <p>Busque ou escaneie um produto para começar</p>
      </div>
    </div>

    <!-- Sugestões de produtos (painel esquerdo, abaixo do carrinho) -->
    <div id="pdv-sugestoes-wrap" style="display:none;flex-shrink:0;padding:8px 16px 10px;border-top:1px solid var(--border)"></div>
  </div>

  <!-- Coluna direita: totais -->
  <div class="pdv-right">
    <!-- Imagem do último produto adicionado -->
    <div id="pdv-produto-img" style="display:none;flex-shrink:0;padding:12px 16px 0;text-align:center">
      <img id="pdv-produto-img-el" src="" alt=""
        style="width:100%;max-height:140px;object-fit:contain;border-radius:8px;background:var(--bg3)">
      <div id="pdv-produto-img-nome" style="font-size:11px;color:var(--text3);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>
    </div>

    <div class="pdv-totals" id="pdv-totals">
      <div class="pdv-total-row">
        <span>Subtotal</span>
        <span id="pdv-subtotal">R$ 0,00</span>
      </div>
      ${podePermissao('dar_desconto_pdv') ? `
      <div class="pdv-total-row discount-row">
        <span>Desconto</span>
        <div class="flex gap-8">
          <input class="input" id="pdv-desconto" type="number" min="0" step="0.01"
            value="0" style="width:90px;padding:4px 8px;font-size:13px"
            oninput="PDV.updateTotals()">
          <span style="font-size:12px;color:var(--text3);line-height:28px">R$</span>
        </div>
      </div>` : `<input type="hidden" id="pdv-desconto" value="0">`}
      <div class="divider"></div>
      <div class="pdv-total-row total-final">
        <span>TOTAL</span>
        <span id="pdv-total" class="text-accent font-syne">R$ 0,00</span>
      </div>
    </div>

    <!-- Saúde da Venda (visível quando há itens no carrinho) -->
    <div id="pdv-saude-wrap" style="display:none;overflow-y:auto;flex-shrink:0"></div>

    <!-- Dica de atalhos (visível quando carrinho vazio) -->
    <div id="pdv-atalhos-wrap" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px">
      <div style="width:100%;max-width:260px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:12px;text-align:center">Atalhos de Teclado</div>
        ${[
          ['F2', 'Buscar produto'],
          ['F3', 'Selecionar cliente'],
          ['F8', 'Limpar carrinho'],
          ['F9', 'Pagamento / Finalizar'],
          ['F12', 'Anotar falta (na busca)'],
          ['↑ ↓', 'Navegar resultados'],
          ['Enter', 'Selecionar / Confirmar'],
          ['Tab', 'Próximo campo'],
          ['ESC', 'Cancelar / Voltar'],
        ].map(([k, v]) => `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px;font-size:12px">
          <kbd style="background:var(--bg3);border:1px solid var(--border2);border-radius:4px;padding:2px 8px;font-family:monospace;color:var(--accent);font-size:11px">${k}</kbd>
          <span style="color:var(--text3)">${v}</span>
        </div>`).join('')}
        <div style="margin-top:14px;border-top:1px solid var(--border);padding-top:10px;font-size:10px;color:var(--text3);text-align:center">
          No pagamento: <kbd style="background:var(--bg3);border:1px solid var(--border2);border-radius:3px;padding:1px 5px;font-family:monospace">1</kbd>–<kbd style="background:var(--bg3);border:1px solid var(--border2);border-radius:3px;padding:1px 5px;font-family:monospace">6</kbd> escolhem a forma
        </div>
      </div>
    </div>

    <!-- Botões de ação -->
    <div class="pdv-actions">
      <button class="btn btn-ghost" onclick="PDV.clearCart()" style="flex:1">🗑 Limpar</button>
      <button class="btn btn-ghost" id="btn-orc" onclick="PDV.salvarComoOrcamento()" style="flex:1" disabled title="Salvar como orçamento sem baixar estoque">
        📝 Orçamento
      </button>
      <button class="btn btn-primary btn-lg" id="btn-finalizar" onclick="PDV.finalizarVenda()" style="flex:2" disabled>
        F9 — Finalizar
      </button>
    </div>
  </div>
</div>

<style>
.pdv-layout{display:grid;grid-template-columns:1fr 320px;height:100%;overflow:hidden}
.pdv-left{display:flex;flex-direction:column;border-right:1px solid var(--border);overflow:hidden}
.pdv-search-wrap{padding:16px 16px 0;position:relative;flex-shrink:0}
.pdv-search{border-radius:var(--radius-lg)!important;font-size:16px!important}
.pdv-search-results{
  position:absolute;left:16px;right:16px;top:calc(100% + 4px);
  background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius-lg);
  z-index:50;max-height:420px;overflow-y:auto;box-shadow:var(--shadow-lg)
}
.search-grid{width:100%;border-collapse:collapse}
.search-grid thead th{
  padding:7px 10px;font-size:10px;font-weight:600;text-transform:uppercase;
  letter-spacing:.04em;color:var(--text3);border-bottom:1px solid var(--border2);
  background:var(--bg3);position:sticky;top:0;white-space:nowrap
}
.search-item{cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s}
.search-item:last-child{border-bottom:none}
.search-item:hover,.search-item.highlighted{background:var(--bg3)}
.search-item td{padding:8px 10px;font-size:13px;vertical-align:middle}
.search-item.out-of-stock{opacity:.5;cursor:not-allowed}
.si-cod{font-size:10px;color:var(--text3);white-space:nowrap}
.si-nome{font-weight:600;line-height:1.3}
.si-sub{font-size:10px;color:var(--text3)}
.si-marca{font-size:12px;color:var(--text2)}
.si-estoque{text-align:center;font-size:12px;white-space:nowrap}
.si-preco{text-align:right;font-weight:700;color:var(--accent);font-family:'Syne',sans-serif;white-space:nowrap}

.pdv-client-bar{
  display:flex;align-items:center;justify-content:space-between;
  padding:8px 16px;border-bottom:1px solid var(--border);flex-shrink:0;
  background:var(--bg2)
}

.pdv-cart{flex:1;overflow-y:auto;padding:12px 16px}
.cart-item{
  display:flex;align-items:center;gap:10px;
  background:var(--bg2);border:1px solid var(--border);
  border-radius:var(--radius-lg);padding:10px 12px;margin-bottom:8px
}
.cart-emoji{font-size:22px;flex-shrink:0}
.cart-info{flex:1;min-width:0}
.cart-name{font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cart-unit{font-size:11px;color:var(--text3)}
.cart-qty{display:flex;align-items:center;gap:6px;flex-shrink:0}
.qty-btn{
  width:24px;height:24px;border-radius:6px;
  background:var(--bg3);border:1px solid var(--border2);
  color:var(--text);cursor:pointer;font-size:14px;
  display:flex;align-items:center;justify-content:center;transition:all .1s
}
.qty-btn:hover{background:var(--accent-bg);border-color:var(--accent);color:var(--accent)}
.qty-num{font-size:14px;font-weight:600;min-width:28px;text-align:center}
.cart-price{font-family:'Syne',sans-serif;font-weight:700;color:var(--accent);white-space:nowrap;margin-left:4px}
.remove-btn{color:var(--text3);cursor:pointer;padding:4px;border-radius:4px;border:none;background:transparent;font-size:14px}
.remove-btn:hover{color:var(--red)}
.cart-item-entrega{border-color:var(--accent)!important;background:var(--accent-bg)!important}
.entrega-ativo{border-color:var(--accent)!important;background:var(--accent-bg)!important;color:var(--accent)!important}

.sugestoes-label{font-size:10px;text-transform:uppercase;letter-spacing:.8px;color:var(--text3);margin-bottom:6px}
.sugestoes-chips{display:flex;flex-wrap:wrap;gap:6px}
.sugestao-chip{
  display:flex;align-items:center;gap:6px;
  background:var(--bg3);border:1px solid var(--border2);
  border-radius:20px;padding:5px 10px 5px 8px;cursor:pointer;
  transition:all .15s;max-width:200px
}
.sugestao-chip:hover{border-color:var(--accent);background:var(--accent-bg)}
.sugestao-chip-emoji{font-size:16px;flex-shrink:0}
.sugestao-chip-info{display:flex;flex-direction:column;min-width:0;flex:1}
.sugestao-chip-nome{font-size:11px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sugestao-chip-preco{font-size:10px;color:var(--accent);font-weight:700}
.sugestao-chip-add{
  width:20px;height:20px;border-radius:50%;
  background:var(--accent);color:#fff;border:none;cursor:pointer;
  font-size:14px;display:flex;align-items:center;justify-content:center;
  flex-shrink:0;transition:transform .1s
}
.sugestao-chip-add:hover{transform:scale(1.15)}

.pdv-right{display:flex;flex-direction:column;background:var(--bg2);overflow:hidden;min-height:0}
.pdv-totals{padding:18px 20px;border-bottom:1px solid var(--border);flex-shrink:0}
.pdv-total-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;font-size:14px}
.pdv-total-row:last-child{margin-bottom:0}
.total-final{font-family:'Syne',sans-serif;font-size:22px;font-weight:700}
.discount-row{color:var(--text2)}

.pdv-payments{padding:16px 20px;flex:1;overflow-y:auto}
.pay-label{font-size:10px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text3);margin-bottom:10px}
.pay-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:14px}
.pay-opt{
  padding:10px 6px;border-radius:var(--radius);
  border:1px solid var(--border2);background:var(--bg3);
  color:var(--text2);cursor:pointer;font-size:11px;font-weight:500;
  font-family:'DM Sans',sans-serif;
  display:flex;flex-direction:column;align-items:center;gap:4px;transition:all .12s
}
.pay-opt:hover{border-color:var(--border3);color:var(--text)}
.pay-opt.active{border-color:var(--accent);background:var(--accent-bg);color:var(--accent)}
.pay-received{margin-top:4px}
.troco-display{
  margin-top:10px;padding:10px 12px;
  border-radius:var(--radius);background:var(--green-bg);
  border:1px solid var(--green-border);color:var(--green);
  font-family:'Syne',sans-serif;font-size:16px;font-weight:700;text-align:center
}

.pdv-actions{
  padding:16px 20px;border-top:1px solid var(--border);
  display:flex;gap:8px;flex-shrink:0
}
</style>`;
  }

  // ─── Busca de produtos ────────────────────────────────────────
  let searchHighlight = -1;
  let searchResults = [];
  let produtoSelecionado = null; // produto aguardando confirmação de qty/preço

  async function onSearch(val) {
    clearTimeout(searchTimeout);
    const box = document.getElementById('pdv-results');
    if (!val.trim()) { box.style.display = 'none'; return; }
    searchTimeout = setTimeout(async () => {
      searchResults = await window.pdv.produtos.buscar(val);
      if (!searchResults.length) {
        const valSafe = val.replace(/'/g, "\\'");
        box.innerHTML = `<div style="padding:16px;text-align:center">
          <div style="color:var(--text3);font-size:13px;margin-bottom:12px">
            Nenhum produto encontrado para "<strong style="color:var(--text)">${val}</strong>"
          </div>
          <button class="btn btn-primary" style="font-size:12px;gap:6px"
            onclick="Faltas.abrirNovaFalta({nome:'${valSafe}'}); document.getElementById('pdv-results').style.display='none'">
            📋 Registrar como Falta / Encomenda
          </button>
        </div>`;
      } else {
        const permiteEstoqueNeg = await window.pdv.config.get('config.vender_estoque_negativo') === true;
        const rows = searchResults.map((p, i) => {
          const semEstoque = p.estoque <= 0 && !permiteEstoqueNeg;
          const estoqueHtml = p.estoque <= 0
            ? (semEstoque ? '<span style="color:var(--red);font-weight:600">❌ Sem estoque</span>' : `<span style="color:var(--yellow)">⚠️ ${p.estoque}</span>`)
            : `<span style="color:var(--green)">${p.estoque}</span>`;
          const prodJson = JSON.stringify({nome: p.nome, sku: p.sku||'', id: p.id}).replace(/"/g,'&quot;');
          const faltaBtn = semEstoque
            ? `<button class="btn btn-ghost btn-sm" style="font-size:10px;padding:2px 7px;margin-left:6px;color:var(--accent);border-color:var(--accent)"
                title="Registrar como falta/encomenda"
                onclick="event.stopPropagation();Faltas.abrirNovaFalta(${prodJson});document.getElementById('pdv-results').style.display='none'">
                📋 Anotar falta</button>` : '';
          return `<tr class="search-item ${semEstoque ? 'out-of-stock' : ''}" id="si-${i}"
            onclick="${!semEstoque ? `PDV.selecionarProduto(${JSON.stringify(p).replace(/"/g, '&quot;')})` : ''}">
            <td class="si-cod">${p.sku || '—'}</td>
            <td><div class="si-nome">${p.emoji ? p.emoji + ' ' : ''}${p.nome}</div><div class="si-sub">${p.ean ? 'EAN: ' + p.ean : ''}</div></td>
            <td class="si-marca">${p.marca || '—'}</td>
            <td class="si-estoque" style="white-space:nowrap">${estoqueHtml}${faltaBtn}</td>
            <td class="si-preco">R$ ${fmtMoney(p.preco_venda)}</td>
          </tr>`;
        }).join('');
        box.innerHTML = `<table class="search-grid">
          <thead><tr>
            <th style="width:80px">SKU</th>
            <th>Produto</th>
            <th style="width:110px">Marca</th>
            <th style="width:180px;text-align:left">Estoque</th>
            <th style="width:100px;text-align:right">Preço</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
      }
      searchHighlight = -1;
      box.style.display = 'block';
    }, 120);
  }

  function onSearchKey(e) {
    // Se o painel de qty/preço estiver visível, redirecionar teclas para ele
    if (document.getElementById('pdv-qty-panel')?.style.display !== 'none') {
      if (e.key === 'Escape') { fecharQtyPanel(); e.preventDefault(); }
      return;
    }
    const items = document.querySelectorAll('.search-item:not(.out-of-stock)');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      searchHighlight = Math.min(searchHighlight + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('highlighted', i === searchHighlight));
      items[searchHighlight]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (searchHighlight <= 0) { searchHighlight = -1; items.forEach(el => el.classList.remove('highlighted')); return; }
      searchHighlight = Math.max(searchHighlight - 1, 0);
      items.forEach((el, i) => el.classList.toggle('highlighted', i === searchHighlight));
      items[searchHighlight]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (searchHighlight >= 0 && searchResults[searchHighlight]) {
        selecionarProduto(searchResults[searchHighlight]);
      } else if (searchResults.length === 1) {
        selecionarProduto(searchResults[0]);
      }
    } else if (e.key === 'F12') {
      e.preventDefault();
      // Anotar falta do produto destacado (ou primeiro resultado)
      const idx = searchHighlight >= 0 ? searchHighlight : 0;
      if (searchResults[idx]) {
        const p = searchResults[idx];
        _abrirModalFaltaPDV({ nome: p.nome, sku: p.sku || '', id: p.id });
      } else if (document.getElementById('pdv-search')?.value.trim()) {
        _abrirModalFaltaPDV({ nome: document.getElementById('pdv-search').value.trim() });
      }
    } else if (e.key === 'Escape') {
      document.getElementById('pdv-results').style.display = 'none';
      searchHighlight = -1;
    }
  }

  // ─── Modal rápido de Falta a partir do PDV ───────────────────
  function _abrirModalFaltaPDV(produto) {
    document.getElementById('pdv-results').style.display = 'none';
    Modal.open(`
      <div style="display:flex;flex-direction:column;gap:12px;min-width:320px">
        <div style="background:var(--bg3);padding:10px 14px;border-radius:8px;font-size:13px">
          <div style="font-weight:600;color:var(--text)">${produto.nome}</div>
          ${produto.sku ? `<div style="font-size:11px;color:var(--text3);margin-top:2px">SKU: ${produto.sku}</div>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <label style="font-size:11px;color:var(--text3);display:block;margin-bottom:4px">Quantidade</label>
            <input id="fpdv-qty" class="input" type="number" min="1" step="1" value="1"
              style="font-size:16px;font-weight:700;text-align:center"
              onkeydown="if(event.key==='Enter'){PDV._confirmarFaltaPDV(${JSON.stringify(produto).replace(/"/g,'&quot;')})}">
          </div>
          <div>
            <label style="font-size:11px;color:var(--text3);display:block;margin-bottom:4px">WhatsApp (opcional)</label>
            <input id="fpdv-wa" class="input" placeholder="(00) 00000-0000"
              onkeydown="if(event.key==='Enter'){PDV._confirmarFaltaPDV(${JSON.stringify(produto).replace(/"/g,'&quot;')})}">
          </div>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text3);display:block;margin-bottom:4px">Nome do cliente (opcional)</label>
          <input id="fpdv-nome" class="input" placeholder="Nome para contato"
            onkeydown="if(event.key==='Enter'){PDV._confirmarFaltaPDV(${JSON.stringify(produto).replace(/"/g,'&quot;')})}">
        </div>
        <div style="display:flex;gap:8px;margin-top:4px">
          <button class="btn btn-ghost" style="flex:1" onclick="Modal.close()">Cancelar</button>
          <button class="btn btn-primary" style="flex:2"
            onclick="PDV._confirmarFaltaPDV(${JSON.stringify(produto).replace(/"/g,'&quot;')})">
            📋 Registrar Falta
          </button>
        </div>
      </div>`, '📋 Anotar Falta / Encomenda');
    setTimeout(() => document.getElementById('fpdv-qty')?.select(), 50);
  }

  async function _confirmarFaltaPDV(produto) {
    const qty = parseInt(document.getElementById('fpdv-qty')?.value) || 1;
    const wa = document.getElementById('fpdv-wa')?.value.trim() || '';
    const nome = document.getElementById('fpdv-nome')?.value.trim() || '';
    Modal.close();
    try {
      await window.pdv.faltas.registrar({
        produto_id: produto.id || null,
        produto_nome: produto.nome,
        produto_sku: produto.sku || '',
        quantidade: qty,
        cliente_nome: nome || null,
        cliente_whatsapp: wa || null,
        status: 'pendente',
      });
      Toast.show(`Falta registrada: ${produto.nome}`, 'success');
      App.atualizarBadgeFaltas();
    } catch (err) {
      Toast.show('Erro ao registrar falta', 'error');
    }
    // Devolver foco ao PDV
    setTimeout(() => document.getElementById('pdv-search')?.focus(), 100);
  }

  // ─── Painel de Qty/Preço (após selecionar produto) ────────────
  function selecionarProduto(produto) {
    produtoSelecionado = produto;
    document.getElementById('pdv-results').style.display = 'none';

    const panel = document.getElementById('pdv-qty-panel');
    if (!panel) return;

    document.getElementById('qp-nome').textContent = produto.nome;
    document.getElementById('qp-info').textContent =
      `${produto.sku || ''} · Estoque: ${produto.estoque} · Preço tabela: R$ ${fmtMoney(produto.preco_venda)}`;
    document.getElementById('qp-qty').value = '1';
    document.getElementById('qp-preco').value = produto.preco_venda.toFixed(2);

    panel.style.display = 'flex';
    document.getElementById('qp-qty').focus();
    document.getElementById('qp-qty').select();
    showProductImage(produto);
  }

  function fecharQtyPanel() {
    const panel = document.getElementById('pdv-qty-panel');
    if (panel) panel.style.display = 'none';
    produtoSelecionado = null;
    document.getElementById('pdv-search').value = '';
    document.getElementById('pdv-search').focus();
  }

  function qpKeyDown(e, campo) {
    if (e.key === 'Escape') { fecharQtyPanel(); e.preventDefault(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (campo === 'qty') {
        // Tab para preço
        document.getElementById('qp-preco').focus();
        document.getElementById('qp-preco').select();
      } else {
        // Preço → confirmar
        confirmarQtyPreco();
      }
    }
    if (e.key === 'Tab' && campo === 'qty') {
      e.preventDefault();
      document.getElementById('qp-preco').focus();
      document.getElementById('qp-preco').select();
    }
    if (e.key === 'Tab' && campo === 'preco') {
      e.preventDefault();
      confirmarQtyPreco();
    }
  }

  async function confirmarQtyPreco() {
    if (!produtoSelecionado) return;
    const qty = parseFloat(document.getElementById('qp-qty')?.value);
    const preco = parseFloat(document.getElementById('qp-preco')?.value) || produtoSelecionado.preco_venda;

    if (qty === 0 || isNaN(qty)) {
      Toast.show('Quantidade inválida', 'error');
      document.getElementById('qp-qty').focus();
      return;
    }

    const eDevolucao = qty < 0;

    if (!eDevolucao) {
      // Venda normal — checar estoque
      const permiteNegativo = await window.pdv.config.get('config.vender_estoque_negativo') === true;
      if (!permiteNegativo && qty > produtoSelecionado.estoque) {
        Toast.show(`Estoque insuficiente. Disponível: ${produtoSelecionado.estoque}`, 'error');
        document.getElementById('qp-qty').focus();
        return;
      }
    }

    addToCartConfirmado(produtoSelecionado, qty, preco, eDevolucao);
    fecharQtyPanel();
  }

  // ─── Carrinho ─────────────────────────────────────────────────
  function addToCartConfirmado(produto, quantidade, precoUnitario, eDevolucao = false) {
    const existing = cart.find(i => i.produto_id === produto.id);
    if (existing) {
      const novaQty = existing.quantidade + quantidade;
      existing.quantidade = novaQty;
      existing.preco_unitario = precoUnitario;
      existing.total = novaQty * precoUnitario;
      if (novaQty === 0) cart.splice(cart.indexOf(existing), 1);
    } else {
      cart.push({
        produto_id: produto.id,
        produto_nome: produto.nome,
        produto_sku: produto.sku,
        emoji: produto.emoji || '📦',
        quantidade,
        preco_unitario: precoUnitario,
        preco_custo: produto.preco_custo || 0,
        desconto: 0,
        total: quantidade * precoUnitario,
        estoque_max: produto.estoque,
        devolucao: eDevolucao,
        entregar: false,
      });
    }
    if (eDevolucao) Toast.show(`Devolução de ${Math.abs(quantidade)} un. adicionada`, 'info');
    renderCart();
    updateTotals();
  }

  function toggleEntregar(produtoId) {
    const item = cart.find(i => i.produto_id === produtoId);
    if (!item || item.devolucao) return;
    // Avisar sobre cliente ao ATIVAR entrega (não ao desativar)
    if (!item.entregar && !selectedClient) {
      Toast.show('Selecione um cliente antes de marcar entrega', 'warning');
      openClientSearch();
      return;
    }
    item.entregar = !item.entregar;
    renderCart();
    _atualizarBadgeEntregas();
  }

  function _itensParaEntrega() {
    return cart.filter(i => i.entregar && !i.devolucao);
  }

  function _atualizarBadgeEntregas() {
    const n = _itensParaEntrega().length;
    const badge = document.getElementById('pdv-entrega-badge');
    if (badge) {
      badge.style.display = n > 0 ? 'inline-flex' : 'none';
      badge.textContent = `🚚 ${n} item${n !== 1 ? 's' : ''} para entrega`;
    }
  }

  function addToCart(produto) {
    selecionarProduto(produto);
  }

  async function changeQty(produtoId, delta) {
    const item = cart.find(i => i.produto_id === produtoId);
    if (!item) return;
    const novaQty = item.quantidade + delta;
    if (novaQty <= 0) { removeItem(produtoId); return; }
    const permiteNegativo = await window.pdv.config.get('config.vender_estoque_negativo') === true;
    if (!permiteNegativo && novaQty > item.estoque_max) {
      Toast.show(`Sem estoque suficiente. Disponível: ${item.estoque_max}`, 'warning');
      return;
    }
    item.quantidade = novaQty;
    item.total = novaQty * item.preco_unitario;
    renderCart();
    updateTotals();
  }

  function removeItem(produtoId) {
    cart = cart.filter(i => i.produto_id !== produtoId);
    renderCart();
    updateTotals();
  }

  function clearCart() {
    if (cart.length === 0 && !modoEdicao) return;
    cart = [];
    selectedClient = null;
    vendedorAtual = null;
    dadosEntrega = null;
    modoEdicao = null;
    payMethod = 'dinheiro';
    valorPago = 0;
    const banner = document.getElementById('pdv-edicao-banner');
    if (banner) banner.style.display = 'none';
    document.getElementById('pdv-desconto').value = 0;
    const imgWrap = document.getElementById('pdv-produto-img');
    if (imgWrap) imgWrap.style.display = 'none';
    renderCart();
    updateTotals();
    renderClientBar();
  }

  function renderCart() {
    const el = document.getElementById('pdv-cart');
    if (!el) return;
    renderSugestoes();
    if (cart.length === 0) {
      el.innerHTML = `<div class="empty-state" style="padding:30px 0">
        <div class="icon">🛒</div><h3>Carrinho vazio</h3>
        <p>Busque ou escaneie um produto para começar</p></div>`;
      _atualizarBadgeEntregas();
      return;
    }
    el.innerHTML = cart.map(item => `
      <div class="cart-item ${item.entregar ? 'cart-item-entrega' : ''}">
        <div class="cart-emoji">${item.emoji}</div>
        <div class="cart-info">
          <div class="cart-name">${item.produto_nome}${item.devolucao ? ' <span style="color:var(--red);font-size:10px">DEV</span>' : ''}</div>
          <div class="cart-unit">R$ ${fmtMoney(item.preco_unitario)} × ${item.quantidade}</div>
        </div>
        <div class="cart-qty">
          <button class="qty-btn" onclick="PDV.changeQty('${item.produto_id}',-1)">−</button>
          <span class="qty-num">${item.quantidade}</span>
          <button class="qty-btn" onclick="PDV.changeQty('${item.produto_id}',1)">+</button>
        </div>
        <div class="cart-price">R$ ${fmtMoney(item.total)}</div>
        ${!item.devolucao ? `
        <button class="qty-btn ${item.entregar ? 'entrega-ativo' : ''}"
          title="${item.entregar ? 'Remover entrega' : 'Marcar para entrega'}"
          onclick="PDV.toggleEntregar('${item.produto_id}')"
          style="width:28px;height:28px;font-size:13px">🚚</button>` : ''}
        <button class="remove-btn" onclick="PDV.removeItem('${item.produto_id}')">✕</button>
      </div>`).join('');
    _atualizarBadgeEntregas();
  }

  // ─── Sugestões ────────────────────────────────────────────────
  async function renderSugestoes() {
    const wrap = document.getElementById('pdv-sugestoes-wrap');
    if (!wrap) return;
    if (cart.length === 0) { wrap.style.display = 'none'; return; }

    const ids = cart.filter(i => !i.devolucao).map(i => i.produto_id);
    const clienteId = selectedClient?.id || null;

    const [porCarrinho, porCliente] = await Promise.all([
      window.pdv.sugestoes.porCarrinho(ids),
      clienteId ? window.pdv.sugestoes.porCliente(clienteId, ids) : Promise.resolve([]),
    ]);

    // Mescla: prioriza comprados pelo cliente, complementa com associação de carrinho
    const vistos = new Set(ids);
    const merged = [];
    for (const s of [...porCliente, ...porCarrinho]) {
      if (!vistos.has(s.id)) { merged.push(s); vistos.add(s.id); }
      if (merged.length >= 6) break;
    }

    // Fallback: produtos mais vendidos no geral
    let label = '💡 Frequentemente levam junto';
    let fonte = merged;
    if (merged.length === 0) {
      fonte = await window.pdv.sugestoes.maisVendidos(ids);
      label = clienteId && porCliente.length === 0
        ? `⭐ Mais vendidos — ${selectedClient.nome.split(' ')[0]} ainda não tem histórico`
        : '⭐ Mais vendidos';
    } else if (clienteId && porCliente.length > 0) {
      label = `💡 ${selectedClient.nome.split(' ')[0]} costuma levar`;
    }

    if (fonte.length === 0) { wrap.style.display = 'none'; return; }

    wrap.style.display = 'block';
    wrap.innerHTML = `
      <div class="sugestoes-label">${label}</div>
      <div class="sugestoes-chips">
        ${fonte.map(s => `
          <div class="sugestao-chip" onclick="PDV.adicionarSugestao('${s.id}')" title="${s.nome}">
            <span class="sugestao-chip-emoji">${s.emoji || '📦'}</span>
            <div class="sugestao-chip-info">
              <span class="sugestao-chip-nome">${s.nome}</span>
              <span class="sugestao-chip-preco">R$ ${fmtMoney(s.preco)}</span>
            </div>
            <button class="sugestao-chip-add" onclick="event.stopPropagation();PDV.adicionarSugestao('${s.id}')">+</button>
          </div>`).join('')}
      </div>`;
  }

  async function adicionarSugestao(produtoId) {
    const produto = await window.pdv.produtos.getById(produtoId);
    if (!produto) return;
    addToCart(produto, 1);
  }

  // ─── Totais ───────────────────────────────────────────────────
  function getSubtotal() { return cart.reduce((a, i) => a + i.total, 0); }
  function getDesconto() { return parseFloat(document.getElementById('pdv-desconto')?.value || 0); }
  // Total pode ser negativo (devolução maior que compra)
  function getTotal() { return getSubtotal() - getDesconto(); }
  function temDevolucao() { return cart.some(i => i.quantidade < 0); }
  function totalNegativo() { return getTotal() < 0; }

  function updateTotals() {
    const sub = getSubtotal();
    const total = getTotal();
    const negativo = total < 0;
    const el_sub = document.getElementById('pdv-subtotal');
    const el_total = document.getElementById('pdv-total');
    const btn = document.getElementById('btn-finalizar');
    if (el_sub) el_sub.textContent = `R$ ${fmtMoney(sub)}`;
    if (el_total) {
      el_total.textContent = negativo
        ? `- R$ ${fmtMoney(Math.abs(total))}`
        : `R$ ${fmtMoney(total)}`;
      el_total.style.color = negativo ? 'var(--red)' : 'var(--accent)';
    }
    // Label do botão indica devolução quando negativo
    if (btn) {
      btn.disabled = cart.length === 0;
      btn.textContent = negativo ? 'F9 — Devolver' : 'F9 — Finalizar';
    }
    const btnOrc = document.getElementById('btn-orc');
    if (btnOrc) btnOrc.disabled = cart.length === 0;
    calcTroco();
    SaudeVenda.atualizar(cart, getDesconto(), payMethod);
  }

  // ─── Fluxo F9: Pagamento → Vendedor → Finalizar ───────────────

  // Etapa 1: modal de forma de pagamento (ou confirmação de devolução)
  async function abrirPagamento() {
    if (cart.length === 0) { Toast.show('Carrinho vazio', 'warning'); return; }
    const total = getTotal();

    // Se há itens de entrega e ainda não agendou, abre tela de entrega primeiro
    if (_itensParaEntrega().length > 0 && !dadosEntrega) {
      _abrirModalEntrega();
      return;
    }

    // Devolução com saldo positivo para o cliente
    if (total < 0) {
      const valorDevolver = Math.abs(total);
      if (!selectedClient) {
        Toast.show('Selecione um cliente para registrar a devolução', 'warning');
        openClientSearch();
        return;
      }
      Modal.open(`
<div style="text-align:center;margin-bottom:20px">
  <div style="font-size:40px;margin-bottom:8px">↩️</div>
  <div style="font-size:13px;color:var(--text3)">VALOR A DEVOLVER AO CLIENTE</div>
  <div class="font-syne" style="font-size:36px;font-weight:800;color:var(--red)">R$ ${fmtMoney(valorDevolver)}</div>
  <div style="font-size:12px;color:var(--text3);margin-top:8px">Cliente: <strong>${selectedClient.nome}</strong></div>
  <div style="font-size:11px;color:var(--text3);margin-top:4px">Um crédito de R$ ${fmtMoney(valorDevolver)} será gerado na carteira do cliente</div>
</div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">ESC · Cancelar</button>
  <button class="btn btn-danger btn-lg" onclick="PDV._confirmarPagamento()">↵ Confirmar Devolução</button>
</div>`, 'Confirmar Devolução');
      return;
    }

    const payOpts = [
      { key: 'dinheiro', icon: '💵', label: 'Dinheiro',  num: '1' },
      { key: 'pix',      icon: '◉',  label: 'PIX',       num: '2' },
      { key: 'credito',  icon: '💳', label: 'Crédito',   num: '3' },
      { key: 'debito',   icon: '💳', label: 'Débito',    num: '4' },
      { key: 'carteira', icon: '👤', label: 'Carteira',  num: '5' },
      { key: 'misto',    icon: '⊕',  label: 'Misto',     num: '6' },
    ];

    Modal.open(`
<div style="text-align:center;margin-bottom:20px">
  <div style="font-size:13px;color:var(--text3)">TOTAL A PAGAR</div>
  <div class="font-syne" style="font-size:36px;font-weight:800;color:var(--accent)">R$ ${fmtMoney(total)}</div>
</div>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:16px">
  ${payOpts.map(o => `
  <button class="pay-opt ${payMethod === o.key ? 'active' : ''}" data-pay="${o.key}"
    onclick="PDV._selectPay('${o.key}',this)" style="padding:14px 8px;font-size:13px;position:relative">
    <span style="position:absolute;top:4px;right:6px;font-size:9px;color:var(--text3);font-family:monospace">${o.num}</span>
    <span style="font-size:20px">${o.icon}</span><span>${o.label}</span>
  </button>`).join('')}
</div>
<div id="modal-pay-extra" style="margin-bottom:12px">${payMethod === 'dinheiro' ? _trocoHtml(total) : ''}</div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">ESC · Cancelar</button>
  <button class="btn btn-primary btn-lg" onclick="PDV._confirmarPagamento()">↵ Enter · Confirmar</button>
</div>`, dadosEntrega ? 'Pagamento — Etapa 2 de 3' : 'Pagamento — F9');
  }

  function _trocoHtml(total) {
    return `
<div style="background:var(--bg3);border-radius:8px;padding:12px">
  <label class="form-label">Valor recebido (R$)</label>
  <input class="input" id="modal-valor-pago" type="number" step="0.01" min="${total.toFixed(2)}"
    value="${total.toFixed(2)}" oninput="PDV._calcTrocoModal(${total})">
  <div id="modal-troco" style="margin-top:8px;font-family:'Syne',sans-serif;font-size:18px;font-weight:700;color:var(--green);text-align:center"></div>
</div>`;
  }

  function _selectPay(method, btn) {
    payMethod = method;
    document.querySelectorAll('.pay-opt').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const extra = document.getElementById('modal-pay-extra');
    if (extra) extra.innerHTML = method === 'dinheiro' ? _trocoHtml(getTotal()) : '';
    // Focar campo de valor para dinheiro; manter foco fora de input para outros métodos
    if (method === 'dinheiro') {
      setTimeout(() => document.getElementById('modal-valor-pago')?.focus(), 30);
    } else {
      document.activeElement?.blur?.();
    }
  }

  function _calcTrocoModal(total) {
    const vp = parseFloat(document.getElementById('modal-valor-pago')?.value || 0);
    const troco = vp - total;
    const el = document.getElementById('modal-troco');
    if (el) el.textContent = troco > 0 ? `Troco: R$ ${fmtMoney(troco)}` : '';
  }

  // Etapa 2: após confirmar pagamento, checar saúde e pedir código do vendedor
  async function _confirmarPagamento() {
    const total = getTotal();

    // Verificar autorização se venda em prejuízo
    const saudeAtual = SaudeVenda.getUltimoResultado();
    if (SaudeVenda.precisaAutorizacao(saudeAtual)) {
      const autorizado = await SaudeVenda.verificarAutorizacao();
      if (!autorizado) return;
    }

    if (payMethod === 'carteira') {
      if (!selectedClient) { Toast.show('Selecione um cliente para usar Carteira', 'warning'); return; }
      const remoteId = selectedClient.remote_id || selectedClient.id;
      const resumo = await window.pdv.creditos.resumo(remoteId).catch(() => null);
      const emAberto = resumo?.total_saldo || 0;
      const disponivel = Math.max(0, (selectedClient.limite_credito || 0) - emAberto);
      if (disponivel < total) {
        Toast.show(`Crédito insuficiente. Disponível: R$ ${fmtMoney(disponivel)}`, 'error'); return;
      }
    }

    valorPago = payMethod === 'dinheiro'
      ? parseFloat(document.getElementById('modal-valor-pago')?.value || total)
      : total;

    dadosEntrega = dadosEntrega || null;
    _abrirModalVendedor();
  }

  // Etapa 2b (condicional): Agendar Entrega
  function _abrirModalEntrega() {
    if (!selectedClient) {
      Modal.close();
      Toast.show('⚠️ Selecione um cliente antes de agendar entrega', 'warning');
      setTimeout(() => openClientSearch(), 150);
      return;
    }
    const c = selectedClient;
    const itens = _itensParaEntrega();
    const totalEnt = itens.reduce((s, i) => s + i.total, 0);
    const cep        = c.cep        || '';
    const logradouro = c.logradouro || c.endereco || '';
    const numero     = c.numero     || '';
    const complemento= c.complemento|| '';
    const bairro     = c.bairro     || '';
    const cidade     = c.cidade     || '';
    const estado     = c.estado     || '';
    const telefone   = c.telefone   || c.whatsapp || '';
    const hoje       = new Date().toISOString().split('T')[0];

    const itensList = itens.map(i =>
      `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:12px">${i.quantidade}x ${i.produto_nome}</span>
        <span style="font-size:12px;font-weight:600">R$ ${fmtMoney(i.total)}</span>
      </div>`
    ).join('');

    Modal.open(`
<div style="margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--border)">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
    <span style="background:var(--accent-bg);color:var(--accent);border-radius:20px;padding:2px 10px;font-size:11px;font-weight:700">ETAPA 1 DE 3</span>
    <span style="font-size:11px;color:var(--text3)">🚚 Entrega → Pagamento → Vendedor</span>
  </div>
  <div style="background:var(--surface2);border-radius:8px;padding:10px;margin-bottom:8px">
    ${itensList}
    <div style="display:flex;justify-content:space-between;padding-top:6px;font-weight:700;font-size:13px">
      <span>${itens.length} item${itens.length > 1 ? 's' : ''} para entrega</span>
      <span style="color:var(--accent)">R$ ${fmtMoney(totalEnt)}</span>
    </div>
  </div>
</div>

<!-- Cliente -->
<div style="background:var(--accent-bg);border:1px solid var(--accent);border-radius:8px;padding:10px;margin-bottom:14px">
  <div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:6px;text-transform:uppercase">📋 Dados do Cliente</div>
  <div style="font-size:13px;font-weight:600;margin-bottom:6px">👤 ${c.nome}</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <div>
      <label class="form-label" style="font-size:10px">Telefone / WhatsApp *</label>
      <input class="input" id="ent-telefone" value="${telefone}" placeholder="(99) 99999-9999" style="font-size:13px">
    </div>
    <div>
      <label class="form-label" style="font-size:10px">CPF / Documento</label>
      <input class="input" id="ent-doc" value="${c.cpf || c.documento || ''}" placeholder="Opcional" style="font-size:13px">
    </div>
  </div>
</div>

<!-- Endereço -->
<div style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;margin-bottom:8px">📍 Endereço de Entrega</div>
<div style="display:grid;grid-template-columns:130px 1fr;gap:10px;margin-bottom:10px">
  <div>
    <label class="form-label">CEP</label>
    <input class="input" id="ent-cep" value="${cep}" placeholder="00000-000" maxlength="9"
      oninput="PDV._buscarCep(this.value)" style="font-size:13px">
  </div>
  <div>
    <label class="form-label">Logradouro *</label>
    <input class="input" id="ent-logradouro" value="${logradouro}" placeholder="Rua, Avenida, Estrada..." style="font-size:13px">
  </div>
</div>
<div style="display:grid;grid-template-columns:80px 1fr 1fr;gap:10px;margin-bottom:10px">
  <div>
    <label class="form-label">Número *</label>
    <input class="input" id="ent-numero" value="${numero}" placeholder="Nº" style="font-size:13px">
  </div>
  <div>
    <label class="form-label">Complemento</label>
    <input class="input" id="ent-complemento" value="${complemento}" placeholder="Apto, Bloco, Casa..." style="font-size:13px">
  </div>
  <div>
    <label class="form-label">Bairro *</label>
    <input class="input" id="ent-bairro" value="${bairro}" placeholder="Bairro" style="font-size:13px">
  </div>
</div>
<div style="display:grid;grid-template-columns:1fr 70px;gap:10px;margin-bottom:10px">
  <div>
    <label class="form-label">Cidade *</label>
    <input class="input" id="ent-cidade" value="${cidade}" placeholder="Cidade" style="font-size:13px">
  </div>
  <div>
    <label class="form-label">UF *</label>
    <input class="input" id="ent-estado" value="${estado}" placeholder="RJ" maxlength="2" style="font-size:13px;text-transform:uppercase">
  </div>
</div>
<div class="form-group" style="margin-bottom:10px">
  <label class="form-label">Ponto de Referência</label>
  <input class="input" id="ent-referencia" value="${c.referencia || ''}" placeholder="Ex: Próximo ao mercado João, portão azul..." style="font-size:13px">
</div>
<div class="form-group" style="margin-bottom:14px">
  <label class="form-label">Instrução de Entrega / Observação</label>
  <textarea class="input" id="ent-obs" rows="2" placeholder="Ex: Ligar antes de chegar, entregar no portão lateral..."
    style="font-size:13px;resize:none">${c.obs_entrega || ''}</textarea>
</div>

<!-- Agendamento -->
<div style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;margin-bottom:8px">📅 Agendamento</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
  <div>
    <label class="form-label">Data de Entrega *</label>
    <input class="input" id="ent-data" type="date" min="${hoje}" value="${hoje}" style="font-size:13px">
  </div>
  <div>
    <label class="form-label">Período preferencial *</label>
    <div style="display:flex;gap:4px;margin-top:4px" id="ent-turno-wrap">
      ${['Qualquer','Manhã','Tarde','Noite'].map((t,i) => {
        const val = ['qualquer','manha','tarde','noite'][i];
        const active = i === 0;
        return `<button onclick="PDV._selecionarTurno('${val}',this)" data-turno="${val}"
          style="flex:1;padding:6px 2px;font-size:11px;border-radius:6px;border:1px solid var(--border);cursor:pointer;
            background:${active?'var(--accent)':'var(--surface2)'};color:${active?'#fff':'var(--text2)'};font-weight:${active?'700':'400'}">${t}</button>`;
      }).join('')}
    </div>
    <input type="hidden" id="ent-turno" value="qualquer">
  </div>
</div>

<div class="modal-actions" style="flex-wrap:wrap;gap:8px">
  <button class="btn btn-ghost" onclick="PDV._voltarParaPagamento()">← Voltar ao Carrinho</button>
  <button class="btn btn-secondary" onclick="PDV._imprimirEntregaModal()" style="gap:6px">🖨️ Imprimir</button>
  <button class="btn btn-primary btn-lg" onclick="PDV._confirmarEntrega()">Confirmar → Pagamento</button>
</div>`, 'Agendar Entrega 🚚');
  }

  function _selecionarTurno(val, btn) {
    document.getElementById('ent-turno').value = val;
    document.querySelectorAll('#ent-turno-wrap button').forEach(b => {
      b.style.background = 'var(--surface2)';
      b.style.color = 'var(--text2)';
      b.style.fontWeight = '400';
    });
    btn.style.background = 'var(--accent)';
    btn.style.color = '#fff';
    btn.style.fontWeight = '700';
  }

  async function _buscarCep(cep) {
    const limpo = cep.replace(/\D/g, '');
    if (limpo.length !== 8) return;
    try {
      const r = await fetch(`https://viacep.com.br/ws/${limpo}/json/`);
      const d = await r.json();
      if (d.erro) return;
      const set = (id, v) => { const el = document.getElementById(id); if (el && v) el.value = v; };
      set('ent-logradouro', d.logradouro);
      set('ent-bairro', d.bairro);
      set('ent-cidade', d.localidade);
      set('ent-estado', d.uf);
      document.getElementById('ent-numero')?.focus();
    } catch {}
  }

  function _voltarParaPagamento() {
    Modal.close();
  }

  async function _imprimirEntregaModal() {
    const c = selectedClient || {};
    const itens = _itensParaEntrega();
    const dados = {
      empresa_nome:     (await window.pdv.config.get('auth.usuario'))?.empresa_nome || 'VargasNexus PDV',
      cliente_nome:     c.nome || document.getElementById('ent-telefone')?.value || '',
      cliente_telefone: document.getElementById('ent-telefone')?.value || '',
      cliente_doc:      document.getElementById('ent-doc')?.value || '',
      cep:              document.getElementById('ent-cep')?.value || '',
      logradouro:       document.getElementById('ent-logradouro')?.value || '',
      numero:           document.getElementById('ent-numero')?.value || '',
      complemento:      document.getElementById('ent-complemento')?.value || '',
      bairro:           document.getElementById('ent-bairro')?.value || '',
      cidade:           document.getElementById('ent-cidade')?.value || '',
      estado:           document.getElementById('ent-estado')?.value || '',
      referencia:       document.getElementById('ent-referencia')?.value || '',
      obs:              document.getElementById('ent-obs')?.value || '',
      data_entrega:     document.getElementById('ent-data')?.value || '',
      turno:            document.getElementById('ent-turno')?.value || 'qualquer',
      itens: itens.map(i => ({ produto_nome: i.produto_nome, quantidade: i.quantidade, total: i.total })),
      total_entrega:    itens.reduce((s, i) => s + i.total, 0),
      emitido_em:       new Date().toISOString(),
    };
    try {
      await window.pdv.print.entrega(dados);
      Toast.show('Comprovante de entrega enviado para impressão', 'success');
    } catch(e) {
      Toast.show('Erro ao imprimir: ' + e.message, 'error');
    }
  }

  async function _confirmarEntrega() {
    const telefone   = document.getElementById('ent-telefone')?.value.trim();
    const logradouro = document.getElementById('ent-logradouro')?.value.trim();
    const numero     = document.getElementById('ent-numero')?.value.trim();
    const bairro     = document.getElementById('ent-bairro')?.value.trim();
    const cidade     = document.getElementById('ent-cidade')?.value.trim();
    const estado     = document.getElementById('ent-estado')?.value.trim();
    const data       = document.getElementById('ent-data')?.value;

    if (!telefone) {
      Toast.show('Informe o telefone / WhatsApp do cliente', 'warning');
      document.getElementById('ent-telefone')?.focus();
      return;
    }
    if (!logradouro || !numero || !bairro || !cidade || !estado || !data) {
      Toast.show('Preencha: logradouro, número, bairro, cidade, estado e data', 'warning');
      return;
    }

    const itens = _itensParaEntrega();
    const telLimpo = telefone.replace(/\D/g, '');
    dadosEntrega = {
      cliente_id:       selectedClient?.remote_id || selectedClient?.id || null,
      cliente_nome:     selectedClient?.nome || null,
      cliente_telefone: telefone,
      cliente_whatsapp: telLimpo ? '55' + telLimpo : null,
      cliente_documento:document.getElementById('ent-doc')?.value.trim() || null,
      cep:              document.getElementById('ent-cep')?.value.trim() || null,
      logradouro, numero,
      complemento:      document.getElementById('ent-complemento')?.value.trim() || null,
      bairro, cidade, estado,
      referencia:       document.getElementById('ent-referencia')?.value.trim() || null,
      observacao:       document.getElementById('ent-obs')?.value.trim() || null,
      data_agendada:    data,
      turno:            document.getElementById('ent-turno')?.value || 'qualquer',
      itens: itens.map(i => ({
        produto_id:    i.produto_id,
        produto_nome:  i.produto_nome,
        produto_sku:   i.produto_sku || null,
        quantidade:    i.quantidade,
        preco_unitario:i.preco_unitario,
        subtotal:      i.total,
      })),
      valor_total_entrega: itens.reduce((s, i) => s + i.total, 0),
    };

    // Atualiza endereço no cadastro do cliente (em background, sem bloquear)
    const remoteId = selectedClient?.remote_id || selectedClient?.id;
    if (remoteId) {
      window.pdv.clientes.atualizarEndereco(remoteId, {
        telefone:    dadosEntrega.cliente_telefone || null,
        whatsapp:    dadosEntrega.cliente_whatsapp || null,
        cep:         dadosEntrega.cep || null,
        logradouro:  dadosEntrega.logradouro || null,
        numero:      dadosEntrega.numero || null,
        complemento: dadosEntrega.complemento || null,
        bairro:      dadosEntrega.bairro || null,
        cidade:      dadosEntrega.cidade || null,
        estado:      dadosEntrega.estado || null,
        referencia:  dadosEntrega.referencia || null,
        obs_entrega: dadosEntrega.observacao || null,
      }).catch(e => console.warn('[ENTREGA] Erro ao atualizar cliente:', e.message));
    }

    // Entrega confirmada → seguir para pagamento
    await abrirPagamento();
  }

  // Etapa 3: modal do código do vendedor
  function _abrirModalVendedor() {
    const ultimoCodigo = vendedorAtual?.codigo || '';
    Modal.open(`
<div style="text-align:center;margin-bottom:20px">
  <div style="font-size:40px;margin-bottom:8px">👤</div>
  <div style="font-size:14px;color:var(--text2)">Informe o código do vendedor</div>
</div>
<input class="input" id="modal-vendedor-codigo" type="text" placeholder="Código do vendedor"
  value="${ultimoCodigo}"
  style="text-align:center;font-size:22px;letter-spacing:4px;font-family:'Syne',sans-serif"
  onkeydown="if(event.key==='Enter'){ if(PDV._vendedorAtualValido()) PDV._finalizarComVendedor(); else PDV._validarVendedor(); }">
<div id="modal-vendedor-nome" style="text-align:center;margin-top:10px;font-size:14px;color:var(--green);min-height:20px">
  ${vendedorAtual ? vendedorAtual.nome : ''}
</div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
  <button class="btn btn-ghost" onclick="PDV._validarVendedor()">Verificar</button>
  <button class="btn btn-primary btn-lg" onclick="PDV._finalizarComVendedor()">✓ Finalizar</button>
</div>`, 'Código do Vendedor');
    setTimeout(() => {
      const inp = document.getElementById('modal-vendedor-codigo');
      if (inp) { inp.focus(); inp.select(); }
    }, 80);
  }

  function _vendedorAtualValido() {
    const codigo = document.getElementById('modal-vendedor-codigo')?.value?.trim();
    return vendedorAtual && vendedorAtual.codigo === codigo;
  }

  async function _validarVendedor() {
    const codigo = document.getElementById('modal-vendedor-codigo')?.value?.trim();
    if (!codigo) return;
    const v = await window.pdv.vendedores.getByCodigo(codigo);
    const nomeEl = document.getElementById('modal-vendedor-nome');
    if (v) {
      vendedorAtual = v;
      if (nomeEl) nomeEl.innerHTML = `<span style="color:var(--green)">✓ ${v.nome}</span>`;
    } else {
      vendedorAtual = null;
      if (nomeEl) nomeEl.innerHTML = `<span style="color:var(--red)">Vendedor não encontrado</span>`;
    }
  }

  // Etapa 4: finalizar de verdade
  async function _finalizarComVendedor() {
    const codigo = document.getElementById('modal-vendedor-codigo')?.value?.trim();
    const exigirVendedor = await window.pdv.config.get('config.exigir_vendedor') !== false;

    if (codigo && !vendedorAtual) {
      await _validarVendedor();
      if (!vendedorAtual) { Toast.show('Código de vendedor inválido', 'error'); return; }
    }
    if (exigirVendedor && !vendedorAtual) {
      Toast.show('Informe o código do vendedor', 'warning');
      document.getElementById('modal-vendedor-codigo')?.focus();
      return;
    }

    Modal.close();
    const total = getTotal();
    const desconto = getDesconto();
    const eDevolucao = total < 0;
    const valorDevolver = eDevolucao ? Math.abs(total) : 0;
    const cfgAll = await window.pdv.config.getAll();

    const venda = {
      cliente_id:   selectedClient?.id   || null,
      cliente_nome: selectedClient?.nome || null,
      // Empresa de estoque (movimentação de saldo)
      empresa_id:          cfgAll?.['auth.usuario']?.empresa_estoque_id  || cfgAll?.['auth.empresa_id'] || null,
      deposito_id:         cfgAll?.['auth.usuario']?.deposito_id          || null,
      // Empresa fiscal (emissão de NFC-e / NF-e)
      empresa_fiscal_id:   cfgAll?.['auth.usuario']?.empresa_fiscal_id   || cfgAll?.['auth.empresa_id'] || null,
      empresa_fiscal_nome: cfgAll?.['auth.usuario']?.empresa_fiscal_nome  || null,
      operador_id: cfgAll?.['auth.usuario']?.id || null,
      operador_nome: cfgAll?.['auth.usuario']?.nome || 'Operador',
      vendedor_id: vendedorAtual?.id || null,
      vendedor_nome: vendedorAtual?.nome || null,
      vendedor_codigo: vendedorAtual?.codigo || null,
      subtotal: getSubtotal(),
      desconto,
      total,
      forma_pagamento: eDevolucao ? 'devolucao' : payMethod,
      valor_pago: eDevolucao ? 0 : valorPago,
      troco: eDevolucao ? valorDevolver : (payMethod === 'dinheiro' ? Math.max(0, valorPago - total) : 0),
      usa_credito: payMethod === 'carteira',
      devolucao: eDevolucao,
      valor_devolvido: valorDevolver,
      itens: cart.map(i => ({
        produto_id: i.produto_id,
        produto_nome: i.produto_nome,
        produto_sku: i.produto_sku,
        quantidade: i.quantidade,
        preco_unitario: i.preco_unitario,
        desconto: i.desconto,
        total: i.total,
      }))
    };

    try {
      let result;
      const emEdicao = modoEdicao;

      if (emEdicao) {
        // ── MODO EDIÇÃO: atualizar venda existente ────────────────
        result = await window.pdv.vendas.editar(emEdicao.vendaId, venda.itens, {
          subtotal:        venda.subtotal,
          desconto:        desconto,
          total:           total,
          forma_pagamento: venda.forma_pagamento,
          valor_pago:      venda.valor_pago,
          troco:           venda.troco,
        });
        result = result || { numero: emEdicao.numero };
        Toast.show(`Venda #${emEdicao.numero} atualizada!`, 'success');
      } else if (eDevolucao) {
        result = await window.pdv.vendas.registrar(venda);
        if (selectedClient) {
          const remoteId = selectedClient.remote_id || selectedClient.id;
          await window.pdv.creditos.criarCredito(remoteId, selectedClient.nome,
            selectedClient.telefone || null, valorDevolver,
            `Devolução PDV #${result.numero}`);
        }
        Toast.show(`Devolução #${result.numero} — Crédito R$ ${fmtMoney(valorDevolver)} na carteira`, 'success');
      } else {
        result = await window.pdv.vendas.registrar(venda);
        Toast.show(`Venda #${result.numero} — ${vendedorAtual?.nome || 'OK'}`, 'success');
      }

      // Registrar entrega se houver dados agendados (apenas em venda nova, não edição)
      if (dadosEntrega && !eDevolucao && !emEdicao) {
        try {
          const cfgAll = await window.pdv.config.getAll();
          await window.pdv.entregas.salvar({
            ...dadosEntrega,
            venda_id:       result.remote_id || null,
            venda_numero:   result.numero,
            numero_local:   String(result.numero),
            empresa_id:     cfgAll?.auth?.empresa_id || '',
            empresa_nome:   cfgAll?.auth?.usuario?.empresa_nome || '',
            created_at:     new Date().toISOString(),
          });
          Toast.show('Entrega agendada!', 'success');
        } catch (eErr) {
          console.warn('[ENTREGA] Erro ao salvar entrega:', eErr.message);
          Toast.show('Venda OK — entrega salva offline', 'warning');
        }
      }

      clearCart();
      _ultimaVenda = { id: result.id, numero: result.numero, remoteId: result.remote_id || null, venda };

      // Se estava convertendo um orçamento, marcá-lo como convertido
      if (window._orcamentoParaConverter) {
        window.pdv.orcamentos.marcarConvertido(window._orcamentoParaConverter).catch(() => {});
        window._orcamentoParaConverter = null;
        const banner = document.getElementById('pdv-edicao-banner');
        if (banner) banner.style.display = 'none';
      }

      Modal.open(renderComprovante(result.numero, venda, result.remote_id), eDevolucao ? 'Comprovante de Devolução' : 'Comprovante');
      _setupComprovanteKeys();
      _enviarImpressao(result.numero, venda);
    } catch (err) {
      Toast.show('Erro ao registrar: ' + err.message, 'error');
    }
  }

  // ─── Atalhos teclado comprovante ──────────────────────────────────────
  function _setupComprovanteKeys() {
    function handler(e) {
      if (!document.getElementById('btn-comprovante-nova')) { document.removeEventListener('keydown', handler, true); return; }
      const tag = (e.target || {}).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const k = e.key;
      if (k === 'Enter' || k === 'n' || k === 'N') { e.preventDefault(); document.getElementById('btn-comprovante-nova')?.click(); }
      else if (k === 'p' || k === 'P') { e.preventDefault(); document.getElementById('btn-comprovante-imprimir')?.click(); }
      else if (k === 'f' || k === 'F') { e.preventDefault(); document.getElementById('btn-comprovante-nfce')?.click(); }
      else if (k === 'Escape') { document.removeEventListener('keydown', handler, true); }
    }
    document.addEventListener('keydown', handler, true);
  }

  // ─── NFC-e Auto-emissão ─────────────────────────────────────────────
  async function _autoEmitirNFCe(result, venda) {
    const usuario = await window.pdv.config.get('auth.usuario');
    if (!usuario?.nfce_habilitada) return;

    Toast.show('Emitindo NFC-e...', 'info', 7000);
    const vendaParaNFCe = { ...venda, numero: result.numero };
    const res = await window.pdv.nfce.emitir(vendaParaNFCe);

    if (res.aguardando) {
      Toast.show('Aguardando autorização SEFAZ...', 'info', 6000);
      await new Promise(r => setTimeout(r, 5000));
      const consulta = await window.pdv.nfce.consultar(res.reference);
      if (consulta.status === 'autorizado') {
        await _sincNFCeBase44(result.remote_id, res.reference, consulta);
      } else {
        Toast.show(`NFC-e: ${consulta.status || 'aguardando'} — verifique nas vendas`, 'warning', 6000);
      }
      return;
    }

    if (res.ok) {
      await _sincNFCeBase44(result.remote_id, res.reference, res.data);
    } else {
      Toast.show(`NFC-e: ${res.erro || 'erro na emissão'}`, 'error', 8000);
    }
  }

  async function _sincNFCeBase44(remoteId, reference, data) {
    const danfeUrl = data?.danfe_url || data?.url_danfe_nfce || null;

    Toast.show(`NFC-e ${data?.numero || ''} Autorizada ✅`, 'success');

    // Atualizar registro local
    const uv = _ultimaVenda;
    if (uv?.id) {
      window.pdv.vendas.atualizarNfce(uv.id, {
        chave: data?.chave_nfe || data?.chave || '',
        numero: data?.numero || '',
        serie: data?.serie || '',
        url_pdf: danfeUrl || '',
        referencia: reference,
      }).catch(() => {});
    }

    if (remoteId) {
      window.pdv.nfce.registrarBase44(remoteId, {
        chave:       data?.chave_nfe || data?.chave || '',
        numero:      data?.numero || '',
        serie:       data?.serie || '',
        status:      data?.status || 'autorizado',
        status_sefaz: data?.status_sefaz || '100',
        motivo_sefaz: data?.motivo || data?.motivo_sefaz || '',
        danfe_url:   danfeUrl || '',
        url_xml:     data?.url_xml || '',
        referencia:  reference,
      }).catch(e => console.warn('[NFCe sync Base44]', e.message));
    }

    if (danfeUrl) {
      window.open(danfeUrl, '_blank');
    }
  }

  async function _reimprimir(numero) {
    const uv = _ultimaVenda;
    if (!uv) return;
    await _enviarImpressao(uv.numero, uv.venda);
    Toast.show('Enviado para impressão', 'success');
  }

  async function _emitirNFCeComprovante() {
    const uv = _ultimaVenda;
    if (!uv) { Toast.show('Nenhuma venda ativa', 'warning'); return; }

    Toast.show('Emitindo NFC-e...', 'info', 7000);
    const vendaParaNFCe = { ...uv.venda, numero: uv.numero };
    const res = await window.pdv.nfce.emitir(vendaParaNFCe);

    if (res.aguardando) {
      Toast.show('Aguardando autorização SEFAZ...', 'info', 6000);
      await new Promise(r => setTimeout(r, 5000));
      const consulta = await window.pdv.nfce.consultar(res.reference);
      if (consulta.status === 'autorizado') {
        await _sincNFCeBase44(uv.remoteId, res.reference, consulta);
      } else {
        Toast.show(`NFC-e: ${consulta.status || 'aguardando'} — verifique em instantes`, 'warning', 6000);
      }
      return;
    }

    if (res.ok) {
      await _sincNFCeBase44(uv.remoteId, res.reference, res.data);
    } else {
      Toast.show(`NFC-e: ${res.erro || 'erro na emissão'}`, 'error', 8000);
    }
  }

  async function _enviarImpressao(numero, venda) {
    try {
      const auto = await window.pdv.config.get('config.imprimir_automatico');
      if (!auto) return;
      const dados = {
        numero,
        empresa_nome: (await window.pdv.config.get('auth.usuario'))?.empresa_nome || 'VargasNexus PDV',
        vendedor_nome: venda.vendedor_nome || null,
        cliente_nome: venda.cliente_nome || null,
        itens: (venda.itens || []).map(i => ({
          produto_nome: i.produto_nome,
          quantidade: i.quantidade,
          preco_unitario: i.preco_unitario,
          subtotal: i.total,
        })),
        subtotal: venda.subtotal,
        desconto: venda.desconto || 0,
        total: venda.total,
        forma_pagamento: venda.forma_pagamento,
        valor_pago: venda.valor_pago,
        troco: venda.troco || 0,
        created_at: venda.created_at || new Date().toISOString(),
      };
      const ip = await window.pdv.config.get('config.print_server_ip');
      if (ip) {
        const res = await window.pdv.print.servidor(dados);
        if (res?.erro) Toast.show('Impressão: ' + res.erro, 'warning');
      } else {
        window.pdv.print.local(dados);
      }
    } catch (e) {
      console.warn('[PRINT] Erro ao enviar impressão:', e.message);
    }
  }

  // Mantido para compatibilidade (não usado mais na UI mas chamado internamente)
  function setPayment(method) { payMethod = method; }
  function calcTroco() {}
  async function finalizarVenda() {
    if (cart.length === 0) { Toast.show('Carrinho vazio', 'warning'); return; }
    // Se há itens para entrega → confirmar entrega ANTES do pagamento
    if (_itensParaEntrega().length > 0) {
      _abrirModalEntrega();
    } else {
      await abrirPagamento();
    }
  }

  function renderComprovante(numero, venda) {
    const itensVenda = venda.itens.filter(i => i.quantidade > 0);
    const itensDevol = venda.itens.filter(i => i.quantidade < 0);
    const totalVenda = itensVenda.reduce((s, i) => s + i.total, 0);
    const totalDevol = itensDevol.reduce((s, i) => s + i.total, 0); // negativo

    const linhaItem = (i, cor) => `
    <div style="display:flex;justify-content:space-between;margin-bottom:4px${cor ? ';color:' + cor : ''}">
      <span>${i.produto_nome} × ${Math.abs(i.quantidade)}</span>
      <span>R$ ${fmtMoney(Math.abs(i.total))}</span>
    </div>`;

    const secaoVendas = itensVenda.length ? `
  <div style="font-size:10px;font-weight:700;color:var(--text3);letter-spacing:1px;margin-bottom:4px">VENDAS</div>
  ${itensVenda.map(i => linhaItem(i)).join('')}
  <div style="display:flex;justify-content:space-between;color:var(--text2);margin-top:2px;padding-top:4px;border-top:1px dotted var(--border2)">
    <span>Subtotal vendas</span><span>R$ ${fmtMoney(totalVenda)}</span>
  </div>` : '';

    const secaoDevol = itensDevol.length ? `
  <div style="font-size:10px;font-weight:700;color:var(--red);letter-spacing:1px;margin:10px 0 4px">DEVOLUÇÕES</div>
  ${itensDevol.map(i => linhaItem(i, 'var(--red)')).join('')}
  <div style="display:flex;justify-content:space-between;color:var(--red);margin-top:2px;padding-top:4px;border-top:1px dotted var(--border2)">
    <span>Total devoluções</span><span>- R$ ${fmtMoney(Math.abs(totalDevol))}</span>
  </div>` : '';

    return `
<div style="font-family:monospace;font-size:13px;line-height:1.6;max-width:360px;margin:0 auto">
  <div style="text-align:center;margin-bottom:16px">
    <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800">PDV VARGAS</div>
    <div style="color:var(--text2);font-size:12px">Venda #${numero} — ${new Date().toLocaleString('pt-BR')}</div>
    ${venda.vendedor_nome ? `<div style="font-size:11px;color:var(--text3)">Vendedor: ${venda.vendedor_nome}</div>` : ''}
    ${venda.cliente_nome || (venda.cliente_id ? 'Cliente' : '') ? `<div style="font-size:11px;color:var(--text3)">Cliente: ${venda.cliente_nome || '-'}</div>` : ''}
  </div>
  <div style="border-top:1px dashed var(--border2);border-bottom:1px dashed var(--border2);padding:10px 0;margin:10px 0">
    ${secaoVendas}
    ${secaoDevol}
  </div>
  ${venda.desconto > 0 ? `<div style="display:flex;justify-content:space-between;color:var(--green)"><span>Desconto</span><span>- R$ ${fmtMoney(venda.desconto)}</span></div>` : ''}
  <div style="display:flex;justify-content:space-between;font-family:'Syne',sans-serif;font-size:18px;font-weight:700;margin-top:10px;border-top:1px dashed var(--border2);padding-top:10px">
    <span>TOTAL</span><span style="color:${venda.total < 0 ? 'var(--red)' : 'var(--accent)'}">R$ ${fmtMoney(Math.abs(venda.total))}</span>
  </div>
  <div style="margin-top:10px;color:var(--text2);font-size:12px">Pagamento: ${venda.forma_pagamento.toUpperCase()}</div>
  ${venda.troco > 0 ? `<div style="color:var(--green)">Troco: R$ ${fmtMoney(venda.troco)}</div>` : ''}
  ${itensDevol.length && venda.total < 0 ? `<div style="color:var(--green);font-size:12px">Crédito na carteira: R$ ${fmtMoney(Math.abs(venda.total))}</div>` : ''}
</div>
<div class="modal-actions" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:16px">
  <button id="btn-comprovante-nova" class="btn btn-primary btn-lg" onclick="Modal.close()" style="grid-column:1/-1;font-size:15px">
    🛒 Nova Venda <span style="font-size:11px;opacity:.7;font-weight:400">[Enter]</span>
  </button>
  <button id="btn-comprovante-imprimir" class="btn btn-ghost" onclick="PDV._reimprimir(${numero})">
    🖨️ Imprimir <span style="font-size:10px;opacity:.6">[P]</span>
  </button>
  <button id="btn-comprovante-nfce" class="btn btn-ghost" onclick="PDV._emitirNFCeComprovante()">
    📄 Emitir NFC-e <span style="font-size:10px;opacity:.6">[F]</span>
  </button>
  <button id="btn-comprovante-fechar" class="btn btn-ghost" style="font-size:11px;color:var(--text3)" onclick="Modal.close()">
    Fechar <span style="font-size:10px;opacity:.6">[ESC]</span>
  </button>
</div>`;
  }

  // ─── Cliente ──────────────────────────────────────────────────
  async function openClientSearch() {
    const html = `
<input class="input" id="client-search" placeholder="Nome, CPF ou telefone..."
  oninput="PDV.searchClientes(this.value)" autocomplete="off">
<div id="client-results" style="margin-top:12px;max-height:300px;overflow-y:auto"></div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
  ${podePermissao('cadastrar_cliente_pdv') ? `<button class="btn btn-ghost btn-sm" onclick="PDV._abrirNovoCliente()">+ Novo Cliente</button>` : ''}
  ${selectedClient ? `<button class="btn btn-danger btn-sm" onclick="PDV.clearClient()">Remover</button>` : ''}
</div>`;
    Modal.open(html, 'Selecionar Cliente', 'Busque pelo nome ou CPF');
    setTimeout(() => document.getElementById('client-search')?.focus(), 100);
  }

  async function _abrirNovoCliente() {
    Modal.open(`
<div class="form-group"><label class="form-label">Nome *</label>
  <input class="input" id="nc-nome" placeholder="Nome completo"></div>
<div class="form-group"><label class="form-label">CPF / CNPJ</label>
  <input class="input" id="nc-cpf" placeholder="000.000.000-00"></div>
<div class="form-group"><label class="form-label">Telefone</label>
  <input class="input" id="nc-tel" placeholder="(00) 00000-0000"></div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="PDV.openClientSearch()">Voltar</button>
  <button class="btn btn-primary" onclick="PDV._salvarNovoCliente()">Cadastrar</button>
</div>`, 'Novo Cliente');
    setTimeout(() => document.getElementById('nc-nome')?.focus(), 100);
  }

  async function _salvarNovoCliente() {
    const nome     = document.getElementById('nc-nome')?.value.trim();
    const cpf_cnpj = document.getElementById('nc-cpf')?.value.trim() || null;
    const telefone = document.getElementById('nc-tel')?.value.trim() || null;
    if (!nome) { Toast.show('Informe o nome do cliente', 'warning'); return; }
    try {
      const id = await window.pdv.clientes.salvar({ nome, cpf_cnpj, telefone });
      // salvar retorna apenas o id — montar objeto completo para selectedClient
      selectedClient = { id, nome, cpf_cnpj, telefone, limite_credito: 0, saldo_credito: 0, saldo_devedor: 0 };
      renderClientBar();
      Modal.close();
      Toast.show(`Cliente "${nome}" cadastrado`, 'success');
    } catch (e) {
      Toast.show('Erro ao cadastrar: ' + e.message, 'error');
    }
  }

  async function searchClientes(val) {
    const clientes = await window.pdv.clientes.buscar(val);
    const el = document.getElementById('client-results');
    if (!el) return;
    el.innerHTML = clientes.map(c => `
      <div class="search-item" onclick="PDV.selectClient(${JSON.stringify(c).replace(/"/g, '&quot;')})">
        <div class="search-item-emoji">👤</div>
        <div class="search-item-info">
          <div class="search-item-name">${c.nome}</div>
          <div class="search-item-sku">${c.cpf_cnpj || ''} ${c.telefone || ''}</div>
        </div>
        <div style="text-align:right;font-size:12px">
          <div style="color:var(--text3)">Limite: R$ ${fmtMoney(c.limite_credito || 0)}</div>
        </div>
      </div>`).join('') || '<div class="empty-state" style="padding:20px 0"><p>Nenhum cliente encontrado</p></div>';
  }

  function selectClient(c) {
    selectedClient = c;
    renderClientBar();
    renderSugestoes();
    Modal.close();
  }

  function clearClient() {
    selectedClient = null;
    renderClientBar();
    Modal.close();
  }

  function showProductImage(produto) {
    const wrap = document.getElementById('pdv-produto-img');
    const img  = document.getElementById('pdv-produto-img-el');
    const nome = document.getElementById('pdv-produto-img-nome');
    if (!wrap || !img) return;
    if (produto.foto_url) {
      img.src = produto.foto_url;
      img.onerror = () => { wrap.style.display = 'none'; };
      img.onload  = () => { wrap.style.display = 'block'; };
      if (nome) nome.textContent = produto.nome;
    } else {
      wrap.style.display = 'none';
    }
  }

  async function renderClientBar() {
    const el = document.getElementById('pdv-client-bar');
    if (!el) return;
    if (selectedClient) {
      const remoteId = selectedClient.remote_id || selectedClient.id;
      const resumo = await window.pdv.creditos.resumo(remoteId).catch(() => null);
      const emAberto = resumo?.total_saldo || 0;
      const disponivel = Math.max(0, (selectedClient.limite_credito || 0) - emAberto);
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px">
          <span>👤</span>
          <div>
            <div style="font-weight:500;font-size:13px">${selectedClient.nome}</div>
            <div style="font-size:11px;color:var(--text2)">
              Limite: R$ ${fmtMoney(selectedClient.limite_credito || 0)} ·
              Em aberto: <span style="color:${emAberto > 0 ? 'var(--red)' : 'var(--text2)'}">R$ ${fmtMoney(emAberto)}</span> ·
              Disponível: <span style="color:${disponivel > 0 ? 'var(--green)' : 'var(--red)'}">R$ ${fmtMoney(disponivel)}</span>
            </div>
          </div>
        </div>
        <div class="flex gap-8">
          ${emAberto > 0 ? `<button class="btn btn-danger btn-sm" onclick="PDV.verContaCliente()">Ver Conta</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="PDV.openClientSearch()">Trocar</button>
        </div>`;
    } else {
      el.innerHTML = `
        <span class="text-muted" style="font-size:12px">👤 Sem cliente</span>
        <button class="btn btn-ghost btn-sm" onclick="PDV.openClientSearch()">+ Selecionar</button>`;
    }
  }

  async function verContaCliente() {
    if (!selectedClient) return;
    const remoteId = selectedClient.remote_id || selectedClient.id;
    const creditos = await window.pdv.creditos.getAbertos(remoteId);
    const resumo = await window.pdv.creditos.resumo(remoteId).catch(() => null);
    const emAberto = resumo?.total_saldo || 0;
    const disponivel = Math.max(0, (selectedClient.limite_credito || 0) - emAberto);

    const renderLista = (items) => !items.length
      ? '<div style="color:var(--text3);text-align:center;padding:24px">Nenhuma conta em aberto</div>'
      : items.map(cr => `
<div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:8px">
  <div class="flex-between" style="margin-bottom:6px">
    <div>
      <span style="font-size:11px;color:var(--text3)">${cr.origem ? cr.origem.toUpperCase() : 'CRÉDITO'}${cr.venda_origem_numero ? ' · Venda #' + cr.venda_origem_numero : ''}</span>
      <div style="font-size:11px;color:var(--text3)">${cr.created_date ? new Date(cr.created_date).toLocaleDateString('pt-BR') : ''}</div>
    </div>
    <div style="text-align:right">
      <div style="font-size:11px;color:var(--text3)">Original: R$ ${fmtMoney(cr.valor_original)}</div>
      <div style="font-weight:700;color:var(--red)">Saldo: R$ ${fmtMoney(cr.saldo_atual)}</div>
    </div>
  </div>
  <div class="flex gap-8" style="margin-top:8px">
    <input class="input" type="number" step="0.01" min="0.01" max="${cr.saldo_atual}"
      id="pdv-rec-${cr.id}" value="${(cr.saldo_atual || 0).toFixed(2)}"
      style="flex:1;padding:6px 10px;font-size:13px">
    <button class="btn btn-primary btn-sm"
      onclick="PDV._receberCredito('${cr.id}',${cr.saldo_atual})">Receber</button>
  </div>
</div>`).join('');

    Modal.open(`
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px">
  <div style="background:var(--bg3);border-radius:8px;padding:10px;text-align:center">
    <div style="font-size:10px;color:var(--text3)">LIMITE</div>
    <div class="font-syne" style="font-size:16px">R$ ${fmtMoney(selectedClient.limite_credito || 0)}</div>
  </div>
  <div style="background:var(--bg3);border-radius:8px;padding:10px;text-align:center">
    <div style="font-size:10px;color:var(--text3)">EM ABERTO</div>
    <div class="font-syne" style="font-size:16px;color:var(--red)">R$ ${fmtMoney(emAberto)}</div>
  </div>
  <div style="background:var(--bg3);border-radius:8px;padding:10px;text-align:center">
    <div style="font-size:10px;color:var(--text3)">DISPONÍVEL</div>
    <div class="font-syne" style="font-size:16px;color:var(--green)">R$ ${fmtMoney(disponivel)}</div>
  </div>
</div>
<div id="pdv-conta-lista">${renderLista(creditos)}</div>
<div class="modal-actions"><button class="btn btn-ghost" onclick="Modal.close()">Fechar</button></div>
`, `Conta — ${selectedClient.nome}`);
  }

  async function _receberCredito(creditoId, saldoAtual) {
    const input = document.getElementById(`pdv-rec-${creditoId}`);
    const valorPago = parseFloat(input?.value) || 0;
    if (valorPago <= 0) { Toast.show('Informe um valor válido', 'error'); return; }
    if (valorPago > saldoAtual + 0.001) { Toast.show('Valor maior que o saldo', 'error'); return; }
    const obs = `Recebimento PDV ${new Date().toLocaleDateString('pt-BR')}`;
    await window.pdv.creditos.receber(creditoId, valorPago, saldoAtual, obs);
    Toast.show(`R$ ${fmtMoney(valorPago)} recebido!`, 'success');
    Modal.close();
    renderClientBar();
  }

  // ─── Cursor invisível ao digitar ─────────────────────────────
  function initCursorHide() {
    let _cursorHideTimer = null;
    let _cursorHidden = false;
    document.addEventListener('keydown', (e) => {
      // Apenas teclas que produzem texto ou são de navegação do PDV
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (!_cursorHidden) {
        document.body.style.cursor = 'none';
        _cursorHidden = true;
      }
    });
    document.addEventListener('mousemove', () => {
      if (_cursorHidden) {
        document.body.style.cursor = '';
        _cursorHidden = false;
      }
    });
  }

  // ─── Atalhos globais de teclado ──────────────────────────────
  function initKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!document.getElementById('pdv-search')) return; // PDV não está ativo

      const modalAberto = document.getElementById('modal-overlay')?.classList.contains('open');
      const tag = e.target.tagName;
      const emInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

      // ── F2: foco na busca ──────────────────────────────────────
      if (e.key === 'F2') {
        e.preventDefault();
        fecharQtyPanel();
        const s = document.getElementById('pdv-search');
        if (s) { s.focus(); s.select(); }
        return;
      }

      // ── F9: pagamento ──────────────────────────────────────────
      if (e.key === 'F9') {
        e.preventDefault();
        if (!modalAberto) finalizarVenda();
        return;
      }

      // ── F3: buscar cliente ─────────────────────────────────────
      if (e.key === 'F3') {
        e.preventDefault();
        if (!modalAberto) openClientSearch();
        return;
      }

      // ── F8: limpar carrinho ────────────────────────────────────
      if (e.key === 'F8') {
        e.preventDefault();
        if (!modalAberto) clearCart();
        return;
      }

      // ── ESC no comprovante: fecha e volta para busca ──────────
      if (e.key === 'Escape' && modalAberto) {
        const temComprovante = document.querySelector('.modal-actions .btn-primary[onclick="Modal.close()"]');
        if (temComprovante) {
          e.preventDefault();
          Modal.close();
          setTimeout(() => {
            const s = document.getElementById('pdv-search');
            if (s) { s.focus(); s.select(); }
          }, 100);
          return;
        }
      }

      // ── Qualquer letra/número fora de input → foca na busca ───
      if (!modalAberto && !emInput) {
        const isPrintable = e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
        if (isPrintable) {
          const s = document.getElementById('pdv-search');
          if (s && document.activeElement !== s) {
            s.focus();
            // não preventDefault para o caractere cair no input
          }
        }
      }

      // ── Atalhos numéricos no modal de pagamento (1-6) ─────────
      if (modalAberto && !emInput) {
        const payMap = { '1':'dinheiro','2':'pix','3':'credito','4':'debito','5':'carteira','6':'misto' };
        if (payMap[e.key] && document.querySelector('.pay-opt')) {
          e.preventDefault();
          const btn = document.querySelector(`.pay-opt[data-pay="${payMap[e.key]}"]`);
          if (btn) { PDV._selectPay(payMap[e.key], btn); }
          return;
        }
        // Enter no modal de pagamento = confirmar
        if (e.key === 'Enter' && document.querySelector('.pay-opt')) {
          e.preventDefault();
          PDV._confirmarPagamento();
          return;
        }
        // Enter no modal de vendedor = validar/finalizar
        if (e.key === 'Enter' && document.getElementById('modal-vendedor-codigo')) {
          e.preventDefault();
          PDV._finalizarComVendedor();
          return;
        }
      }
    });
  }

  function entrarModoEdicao(venda) {
    // Limpar estado atual
    cart = [];
    dadosEntrega = null;
    vendedorAtual = null;
    payMethod = venda.forma_pagamento || 'dinheiro';
    valorPago = 0;

    // Guardar referência da venda original
    modoEdicao = { vendaId: venda.id, numero: venda.numero, remote_id: venda.remote_id || null };

    // Carregar itens no carrinho
    for (const item of (venda.itens || [])) {
      cart.push({
        produto_id:     item.produto_id,
        produto_nome:   item.produto_nome,
        produto_sku:    item.produto_sku || '',
        emoji:          '📦',
        quantidade:     item.quantidade,
        preco_unitario: item.preco_unitario,
        preco_custo:    0,
        desconto:       item.desconto || 0,
        total:          item.total,
        estoque_max:    9999,
        devolucao:      item.quantidade < 0,
        entregar:       false,
      });
    }

    // Carregar cliente se existir
    if (venda.cliente_id) {
      window.pdv.clientes.getById(venda.cliente_id).then(c => {
        if (c) { selectedClient = c; renderClientBar(); }
      }).catch(() => {});
    }

    // Atualizar desconto
    const elDesc = document.getElementById('pdv-desconto');
    if (elDesc) elDesc.value = venda.desconto || 0;

    // Mostrar banner
    const banner = document.getElementById('pdv-edicao-banner');
    const label  = document.getElementById('pdv-edicao-label');
    if (banner) banner.style.display = 'flex';
    if (label)  label.textContent = `✏️ Editando Venda #${venda.numero}`;

    renderCart();
    updateTotals();
    Toast.show(`Venda #${venda.numero} carregada para edição`, 'info');
  }

  function cancelarEdicao() {
    modoEdicao = null;
    const banner = document.getElementById('pdv-edicao-banner');
    if (banner) banner.style.display = 'none';
    clearCart();
    Toast.show('Edição cancelada', 'warning');
  }

  // Salva carrinho atual como orçamento (sem baixar estoque, sem financeiro)
  async function salvarComoOrcamento() {
    if (!cart.length) { Toast.show('Carrinho vazio', 'warning'); return; }

    const subtotal = getSubtotal();
    const desconto = parseFloat(document.getElementById('pdv-desconto')?.value) || 0;
    const total = Math.max(0, subtotal - desconto);
    const usuario = await window.pdv.config.get('auth.usuario') || {};

    const orc = {
      cliente_id:       selectedClient?.id || null,
      cliente_nome:     selectedClient?.nome || null,
      cliente_telefone: selectedClient?.telefone || null,
      vendedor_nome:    vendedorAtual?.nome || usuario.nome || null,
      forma_pagamento:  payMethod || 'dinheiro',
      validade_dias:    7,
      subtotal, desconto, total,
      observacao:       null,
      itens: cart.filter(i => i.quantidade > 0).map(i => ({
        produto_id:     i.produto_id,
        produto_nome:   i.produto_nome,
        produto_sku:    i.produto_sku || null,
        quantidade:     i.quantidade,
        preco_unitario: i.preco_unitario,
        desconto:       i.desconto || 0,
        total:          i.total,
      })),
    };

    try {
      const result = await window.pdv.orcamentos.registrar(orc);
      Toast.show(`Orçamento #${result.numero} salvo! O carrinho foi mantido.`, 'success');
    } catch (err) {
      Toast.show('Erro ao salvar orçamento: ' + err.message, 'error');
    }
  }

  // Carrega itens de um orçamento no carrinho (vindo de Orcamentos.converterEmVenda)
  async function carregarDoOrcamento(orc) {
    clearCart();
    modoEdicao = null;

    for (const item of (orc.itens || [])) {
      // Busca o produto local pelo produto_id ou sku para pegar emoji/unidade
      let prod = null;
      if (item.produto_id) {
        try { prod = await window.pdv.produtos.getById(item.produto_id); } catch {}
      }
      cart.push({
        produto_id:     item.produto_id || null,
        produto_nome:   item.produto_nome,
        produto_sku:    item.produto_sku || null,
        preco_unitario: item.preco_unitario,
        quantidade:     item.quantidade,
        desconto:       item.desconto || 0,
        total:          item.total,
        unidade:        prod?.unidade || 'UN',
        emoji:          prod?.emoji   || '📦',
        estoque_max:    9999,
        devolucao:      false,
        entregar:       false,
      });
    }

    if (orc.cliente_id) {
      try {
        const c = await window.pdv.clientes.getById(orc.cliente_id);
        if (c) { selectedClient = c; renderClientBar(); }
      } catch {}
    }

    const elDesc = document.getElementById('pdv-desconto');
    if (elDesc) elDesc.value = orc.desconto || 0;

    // Mostra banner de orçamento
    const banner = document.getElementById('pdv-edicao-banner');
    const label  = document.getElementById('pdv-edicao-label');
    if (banner) banner.style.display = 'flex';
    if (label)  label.textContent = `📝 Orçamento #${orc.numero} → converter em venda`;

    renderCart();
    updateTotals();

    // Quando venda for finalizada, marcar orçamento como convertido
    window._orcamentoParaConverter = orc.id;
  }

  function init() {
    SaudeVenda.init();
    initKeyboard();
    initCursorHide();
    renderClientBar();
    // Restaurar carrinho se houver itens da sessão anterior
    if (cart.length > 0) {
      renderCart();
      updateTotals();
    }
  }

  return { render, init, onSearch, onSearchKey, _abrirModalFaltaPDV, _confirmarFaltaPDV,
    selecionarProduto, fecharQtyPanel, qpKeyDown, confirmarQtyPreco,
    addToCart, changeQty, removeItem, clearCart, adicionarSugestao,
    toggleEntregar, _selecionarTurno, entrarModoEdicao, cancelarEdicao,
    setPayment, calcTroco, finalizarVenda, abrirPagamento, updateTotals,
    _selectPay, _calcTrocoModal, _confirmarPagamento,
    _abrirModalEntrega, _buscarCep, _voltarParaPagamento, _confirmarEntrega, _imprimirEntregaModal,
    _abrirModalVendedor, _validarVendedor, _finalizarComVendedor, _vendedorAtualValido,
    openClientSearch, searchClientes, selectClient, clearClient,
    _abrirNovoCliente, _salvarNovoCliente,
    _reimprimir, _enviarImpressao, _emitirNFCeComprovante,
    verContaCliente, _receberCredito,
    salvarComoOrcamento, carregarDoOrcamento };
})();

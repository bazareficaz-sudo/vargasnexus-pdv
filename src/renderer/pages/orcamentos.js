// ─── Orçamentos ───────────────────────────────────────────────────
const Orcamentos = (() => {
  let _lista   = [];
  let _cart    = [];
  let _cliente = null;
  let _searchTimeout = null;
  let _modoNovo = false;

  // ─── Render principal ────────────────────────────────────────────
  function render() {
    return `<div id="orc-root">${_modoNovo ? _renderFormNovo() : _renderLista()}</div>`;
  }

  function init() {
    if (_modoNovo) {
      _initForm();
    } else {
      load();
    }
  }

  // ─── Lista de orçamentos ─────────────────────────────────────────
  function _renderLista() {
    return `
<div class="page-header">
  <div><div class="page-title">Orçamentos</div></div>
  <div class="page-actions" style="display:flex;gap:8px;align-items:center">
    <input class="input" id="orc-busca" type="text" placeholder="🔍 Cliente ou número..."
      style="min-width:180px" oninput="Orcamentos.load()">
    <select class="input" id="orc-status" onchange="Orcamentos.load()" style="width:auto">
      <option value="">Todos</option>
      <option value="pendente">Pendente</option>
      <option value="aprovado">Aprovado</option>
      <option value="convertido">Convertido</option>
      <option value="cancelado">Cancelado</option>
    </select>
    <button class="btn btn-primary" onclick="Orcamentos.abrirNovo()">+ Novo Orçamento</button>
  </div>
</div>
<div id="orc-lista" style="padding:0 24px 24px">
  <div style="color:var(--text3);text-align:center;padding:40px">Carregando...</div>
</div>`;
  }

  async function load() {
    const busca  = document.getElementById('orc-busca')?.value?.trim() || '';
    const status = document.getElementById('orc-status')?.value || '';
    _lista = await window.pdv.orcamentos.listar({ busca, status });
    _renderTabela();
  }

  function _renderTabela() {
    const el = document.getElementById('orc-lista');
    if (!el) return;

    if (!_lista.length) {
      el.innerHTML = `<div style="color:var(--text3);text-align:center;padding:60px;font-size:14px">
        Nenhum orçamento encontrado.<br>
        <button class="btn btn-primary" style="margin-top:16px" onclick="Orcamentos.abrirNovo()">+ Criar primeiro orçamento</button>
      </div>`;
      return;
    }

    const hoje = new Date();
    const rows = _lista.map(o => {
      const venc = new Date(o.created_at);
      venc.setDate(venc.getDate() + (o.validade_dias || 7));
      const expirado = o.status === 'pendente' && venc < hoje;
      const status = expirado ? 'expirado' : o.status;
      const badge = {
        pendente:   `<span class="badge badge-yellow">Pendente</span>`,
        aprovado:   `<span class="badge badge-green">Aprovado</span>`,
        convertido: `<span class="badge" style="background:var(--accent-bg);color:var(--accent)">Convertido</span>`,
        cancelado:  `<span class="badge badge-red">Cancelado</span>`,
        expirado:   `<span class="badge" style="background:var(--bg3);color:var(--text3)">Expirado</span>`,
      }[status] || `<span class="badge">${status}</span>`;

      return `
<tr onclick="Orcamentos.verDetalhes('${o.id}')" style="cursor:pointer">
  <td style="font-weight:700;font-family:'Syne',sans-serif">#${o.numero}</td>
  <td style="font-size:12px;color:var(--text3)">${_fmtData(o.created_at)}</td>
  <td>${o.cliente_nome || '<span style="color:var(--text3)">—</span>'}</td>
  <td style="text-align:right;font-weight:600;color:var(--accent)">R$ ${fmtMoney(o.total)}</td>
  <td>${badge}</td>
  <td style="font-size:12px;color:${expirado?'var(--red)':'var(--text3)'}">
    ${o.status === 'pendente' || o.status === 'aprovado' ? _fmtData(venc.toISOString()) : '—'}
  </td>
  <td onclick="event.stopPropagation()">
    <div style="display:flex;gap:4px">
      <button class="btn btn-ghost btn-sm" title="Ver detalhes" onclick="Orcamentos.verDetalhes('${o.id}')">👁️</button>
      ${o.status === 'pendente' || o.status === 'aprovado'
        ? `<button class="btn btn-ghost btn-sm" title="Converter em venda" onclick="Orcamentos.converterEmVenda('${o.id}')">🛒</button>`
        : ''}
      ${o.status !== 'cancelado' && o.status !== 'convertido'
        ? `<button class="btn btn-ghost btn-sm" title="Cancelar" onclick="Orcamentos.cancelar('${o.id}')">🗑️</button>`
        : ''}
    </div>
  </td>
</tr>`;
    }).join('');

    el.innerHTML = `
<table style="width:100%;border-collapse:collapse">
  <thead>
    <tr style="border-bottom:2px solid var(--border)">
      <th style="text-align:left;padding:10px 8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Nº</th>
      <th style="text-align:left;padding:10px 8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Data</th>
      <th style="text-align:left;padding:10px 8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Cliente</th>
      <th style="text-align:right;padding:10px 8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Total</th>
      <th style="padding:10px 8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Status</th>
      <th style="padding:10px 8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Válido até</th>
      <th style="padding:10px 8px"></th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>`;
  }

  // ─── Formulário novo orçamento ────────────────────────────────────
  function abrirNovo() {
    _cart    = [];
    _cliente = null;
    _modoNovo = true;
    document.getElementById('orc-root').innerHTML = _renderFormNovo();
    _initForm();
  }

  function fecharNovo() {
    _modoNovo = false;
    document.getElementById('orc-root').innerHTML = _renderLista();
    load();
  }

  function _renderFormNovo() {
    return `
<div class="page-header">
  <div style="display:flex;align-items:center;gap:12px">
    <button class="btn btn-ghost btn-sm" onclick="Orcamentos.fecharNovo()">← Voltar</button>
    <div class="page-title">Novo Orçamento</div>
  </div>
  <div class="page-actions">
    <button class="btn btn-primary" onclick="Orcamentos.salvar()">💾 Salvar Orçamento</button>
  </div>
</div>

<div style="display:grid;grid-template-columns:1fr 320px;gap:0;height:calc(100vh - 100px);overflow:hidden">

  <!-- Coluna esquerda: busca + itens -->
  <div style="display:flex;flex-direction:column;border-right:1px solid var(--border);overflow:hidden">

    <!-- Busca de produto -->
    <div style="padding:16px;border-bottom:1px solid var(--border);flex-shrink:0;position:relative">
      <input class="input input-lg" id="orc-prod-search"
        placeholder="🔍 Buscar produto por nome, SKU ou EAN..."
        oninput="Orcamentos._onSearch(this.value)"
        onkeydown="Orcamentos._onSearchKey(event)"
        autocomplete="off">
      <div id="orc-search-results" style="
        display:none;position:absolute;left:16px;right:16px;top:calc(100% - 4px);
        background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius-lg);
        z-index:50;max-height:360px;overflow-y:auto;box-shadow:var(--shadow-lg)
      "></div>
    </div>

    <!-- Itens do orçamento -->
    <div style="flex:1;overflow-y:auto;padding:16px" id="orc-cart">
      <div style="color:var(--text3);text-align:center;padding:40px;font-size:14px">
        Adicione produtos acima
      </div>
    </div>
  </div>

  <!-- Coluna direita: cliente + condições + totais -->
  <div style="display:flex;flex-direction:column;overflow-y:auto;padding:16px;gap:16px;background:var(--bg2)">

    <!-- Cliente -->
    <div>
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:6px">Cliente (opcional)</div>
      <div id="orc-cliente-box" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px;min-height:40px">
        <div style="color:var(--text3);font-size:13px">Nenhum cliente selecionado</div>
      </div>
      <div style="position:relative;margin-top:6px">
        <input class="input" id="orc-cli-search" placeholder="🔍 Buscar cliente..."
          oninput="Orcamentos._onClientSearch(this.value)">
        <div id="orc-cli-results" style="
          display:none;position:absolute;left:0;right:0;top:calc(100%+4px);
          background:var(--bg2);border:1px solid var(--border2);border-radius:8px;
          z-index:50;max-height:200px;overflow-y:auto;box-shadow:var(--shadow-lg)
        "></div>
      </div>
    </div>

    <!-- Validade e forma pagamento -->
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div>
        <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Validade (dias)</label>
        <input class="input" id="orc-validade" type="number" min="1" max="365" value="7" style="text-align:center">
      </div>
      <div>
        <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Pagamento</label>
        <select class="input" id="orc-forma">
          <option value="dinheiro">Dinheiro</option>
          <option value="pix">PIX</option>
          <option value="credito">Cartão Crédito</option>
          <option value="debito">Cartão Débito</option>
          <option value="boleto">Boleto</option>
          <option value="outros">Outros</option>
        </select>
      </div>
    </div>

    <!-- Desconto geral -->
    <div>
      <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Desconto (R$)</label>
      <input class="input" id="orc-desconto" type="number" min="0" step="0.01" value="0"
        oninput="Orcamentos._recalcTotals()">
    </div>

    <!-- Observação -->
    <div>
      <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Observação</label>
      <textarea class="input" id="orc-obs" rows="3" placeholder="Condições, validade especial, etc."
        style="resize:none"></textarea>
    </div>

    <!-- Totais -->
    <div style="border-top:1px solid var(--border);padding-top:12px;margin-top:auto">
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px">
        <span style="color:var(--text3)">Subtotal</span>
        <span id="orc-tot-sub">R$ 0,00</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px">
        <span style="color:var(--text3)">Desconto</span>
        <span id="orc-tot-desc" style="color:var(--red)">− R$ 0,00</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:20px;font-weight:700;font-family:'Syne',sans-serif;color:var(--accent)">
        <span>Total</span>
        <span id="orc-tot">R$ 0,00</span>
      </div>
    </div>

    <button class="btn btn-primary btn-lg" onclick="Orcamentos.salvar()">💾 Salvar Orçamento</button>
  </div>
</div>`;
  }

  function _initForm() {
    document.getElementById('orc-prod-search')?.focus();
  }

  // ─── Busca de produto ─────────────────────────────────────────────
  function _onSearch(val) {
    clearTimeout(_searchTimeout);
    if (!val.trim()) { _hideResults(); return; }
    _searchTimeout = setTimeout(async () => {
      const res = await window.pdv.produtos.buscar(val);
      _showResults(res, val);
    }, 250);
  }

  function _showResults(items, query) {
    const el = document.getElementById('orc-search-results');
    if (!el) return;
    if (!items.length) {
      el.style.display = 'none';
      return;
    }
    el.innerHTML = items.slice(0, 30).map((p, i) => `
<div class="search-item" data-idx="${i}" onclick="Orcamentos._addItem('${p.id}','${(p.nome||'').replace(/'/g,"\\'")}','${p.sku||''}',${p.preco_venda||0},'${p.unidade||'UN'}','${p.emoji||'📦'}')">
  <table class="search-grid" style="width:100%">
    <tr>
      <td style="padding:8px 10px;width:32px;font-size:20px">${p.emoji||'📦'}</td>
      <td style="padding:8px 4px">
        <div style="font-weight:600;font-size:13px">${p.nome}</div>
        <div style="font-size:11px;color:var(--text3)">${p.sku||''} ${p.ean?'· '+p.ean:''}</div>
      </td>
      <td style="padding:8px 10px;text-align:right;white-space:nowrap">
        <div style="font-weight:700;color:var(--accent);font-family:'Syne',sans-serif">R$ ${fmtMoney(p.preco_venda)}</div>
        <div style="font-size:11px;color:var(--text3)">${p.unidade||'UN'}</div>
      </td>
    </tr>
  </table>
</div>`).join('');
    el.style.display = 'block';
  }

  function _hideResults() {
    const el = document.getElementById('orc-search-results');
    if (el) el.style.display = 'none';
  }

  function _onSearchKey(e) {
    if (e.key === 'Escape') { _hideResults(); return; }
    if (e.key === 'Enter') {
      const first = document.querySelector('#orc-search-results .search-item');
      if (first) first.click();
    }
  }

  function _addItem(id, nome, sku, preco, unidade, emoji) {
    const existing = _cart.find(i => i.produto_id === id);
    if (existing) {
      existing.quantidade += 1;
      existing.total = existing.quantidade * existing.preco_unitario - existing.desconto;
    } else {
      _cart.push({
        produto_id: id, produto_nome: nome, produto_sku: sku,
        quantidade: 1, preco_unitario: preco, desconto: 0, total: preco,
        unidade, emoji,
      });
    }
    _hideResults();
    document.getElementById('orc-prod-search').value = '';
    document.getElementById('orc-prod-search').focus();
    _renderCart();
    _recalcTotals();
  }

  function _renderCart() {
    const el = document.getElementById('orc-cart');
    if (!el) return;
    if (!_cart.length) {
      el.innerHTML = `<div style="color:var(--text3);text-align:center;padding:40px;font-size:14px">Adicione produtos acima</div>`;
      return;
    }
    el.innerHTML = _cart.map((item, idx) => `
<div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;display:flex;align-items:center;gap:10px">
  <span style="font-size:20px;flex-shrink:0">${item.emoji||'📦'}</span>
  <div style="flex:1;min-width:0">
    <div style="font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.produto_nome}</div>
    <div style="font-size:11px;color:var(--text3)">${item.produto_sku||''} · R$ ${fmtMoney(item.preco_unitario)}/un</div>
  </div>
  <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
    <button onclick="Orcamentos._decQty(${idx})" style="width:24px;height:24px;border-radius:6px;background:var(--bg3);border:1px solid var(--border2);cursor:pointer;font-size:14px">−</button>
    <input type="number" value="${item.quantidade}" min="0.001" step="1"
      style="width:52px;text-align:center;font-size:14px;font-weight:600;border:1px solid var(--border2);border-radius:6px;background:var(--bg3);color:var(--text);padding:2px 4px"
      oninput="Orcamentos._setQty(${idx},this.value)">
    <button onclick="Orcamentos._incQty(${idx})" style="width:24px;height:24px;border-radius:6px;background:var(--bg3);border:1px solid var(--border2);cursor:pointer;font-size:14px">+</button>
  </div>
  <div style="font-weight:700;color:var(--accent);font-family:'Syne',sans-serif;min-width:70px;text-align:right">
    R$ ${fmtMoney(item.total)}
  </div>
  <button onclick="Orcamentos._removeItem(${idx})" style="color:var(--text3);cursor:pointer;padding:4px;border-radius:4px;border:none;background:transparent;font-size:14px" title="Remover">✕</button>
</div>`).join('');
  }

  function _incQty(idx) {
    _cart[idx].quantidade += 1;
    _cart[idx].total = _cart[idx].quantidade * _cart[idx].preco_unitario - _cart[idx].desconto;
    _renderCart(); _recalcTotals();
  }

  function _decQty(idx) {
    if (_cart[idx].quantidade <= 1) { _removeItem(idx); return; }
    _cart[idx].quantidade -= 1;
    _cart[idx].total = _cart[idx].quantidade * _cart[idx].preco_unitario - _cart[idx].desconto;
    _renderCart(); _recalcTotals();
  }

  function _setQty(idx, val) {
    const q = parseFloat(val) || 0;
    if (q <= 0) { _removeItem(idx); return; }
    _cart[idx].quantidade = q;
    _cart[idx].total = q * _cart[idx].preco_unitario - _cart[idx].desconto;
    _recalcTotals();
  }

  function _removeItem(idx) {
    _cart.splice(idx, 1);
    _renderCart(); _recalcTotals();
  }

  function _recalcTotals() {
    const subtotal = _cart.reduce((s, i) => s + i.total, 0);
    const desc = parseFloat(document.getElementById('orc-desconto')?.value) || 0;
    const total = Math.max(0, subtotal - desc);
    const sub = document.getElementById('orc-tot-sub');
    const descEl = document.getElementById('orc-tot-desc');
    const totEl = document.getElementById('orc-tot');
    if (sub) sub.textContent = `R$ ${fmtMoney(subtotal)}`;
    if (descEl) descEl.textContent = `− R$ ${fmtMoney(desc)}`;
    if (totEl) totEl.textContent = `R$ ${fmtMoney(total)}`;
  }

  // ─── Busca de cliente ─────────────────────────────────────────────
  function _onClientSearch(val) {
    clearTimeout(_searchTimeout);
    if (!val.trim()) { document.getElementById('orc-cli-results').style.display='none'; return; }
    _searchTimeout = setTimeout(async () => {
      const res = await window.pdv.clientes.buscar(val);
      const el = document.getElementById('orc-cli-results');
      if (!el) return;
      if (!res.length) { el.style.display='none'; return; }
      el.innerHTML = res.slice(0, 10).map(c => `
<div onclick="Orcamentos._selecionarCliente('${c.id}','${(c.nome||'').replace(/'/g,"\\'")}','${c.telefone||''}','${c.remote_id||''}')"
  style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s"
  onmouseenter="this.style.background='var(--bg3)'" onmouseleave="this.style.background=''">
  <div style="font-weight:600;font-size:13px">${c.nome}</div>
  <div style="font-size:11px;color:var(--text3)">${c.telefone||''} ${c.cpf_cnpj?'· '+c.cpf_cnpj:''}</div>
</div>`).join('');
      el.style.display = 'block';
    }, 250);
  }

  function _selecionarCliente(id, nome, telefone, remoteId) {
    _cliente = { id, nome, telefone, remote_id: remoteId };
    const box = document.getElementById('orc-cliente-box');
    if (box) box.innerHTML = `
<div style="display:flex;justify-content:space-between;align-items:center">
  <div>
    <div style="font-weight:600;font-size:13px">${nome}</div>
    <div style="font-size:11px;color:var(--text3)">${telefone||'Sem telefone'}</div>
  </div>
  <button onclick="Orcamentos._limparCliente()" style="background:none;border:none;cursor:pointer;color:var(--text3);font-size:14px" title="Remover">✕</button>
</div>`;
    document.getElementById('orc-cli-search').value = '';
    document.getElementById('orc-cli-results').style.display = 'none';
  }

  function _limparCliente() {
    _cliente = null;
    const box = document.getElementById('orc-cliente-box');
    if (box) box.innerHTML = `<div style="color:var(--text3);font-size:13px">Nenhum cliente selecionado</div>`;
  }

  // ─── Salvar ──────────────────────────────────────────────────────
  async function salvar() {
    if (!_cart.length) { Toast.show('Adicione pelo menos um produto', 'error'); return; }
    const subtotal = _cart.reduce((s, i) => s + i.total, 0);
    const desconto = parseFloat(document.getElementById('orc-desconto')?.value) || 0;
    const total = Math.max(0, subtotal - desconto);
    const usuario = await window.pdv.config.get('auth.usuario') || {};

    const orc = {
      cliente_id:       _cliente?.id || null,
      cliente_nome:     _cliente?.nome || null,
      cliente_telefone: _cliente?.telefone || null,
      vendedor_nome:    usuario.nome || null,
      forma_pagamento:  document.getElementById('orc-forma')?.value || 'dinheiro',
      validade_dias:    parseInt(document.getElementById('orc-validade')?.value) || 7,
      subtotal, desconto, total,
      observacao:       document.getElementById('orc-obs')?.value?.trim() || null,
      itens:            _cart.map(i => ({
        produto_id:     i.produto_id,
        produto_nome:   i.produto_nome,
        produto_sku:    i.produto_sku || null,
        quantidade:     i.quantidade,
        preco_unitario: i.preco_unitario,
        desconto:       i.desconto || 0,
        total:          i.total,
      })),
    };

    const btn = document.querySelector('[onclick="Orcamentos.salvar()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Salvando...'; }

    try {
      const result = await window.pdv.orcamentos.registrar(orc);
      Toast.show(`Orçamento #${result.numero} salvo!`, 'success');
      _modoNovo = false;
      document.getElementById('orc-root').innerHTML = _renderLista();
      load();
    } catch (err) {
      Toast.show('Erro ao salvar orçamento', 'error');
      if (btn) { btn.disabled = false; btn.textContent = '💾 Salvar Orçamento'; }
    }
  }

  // ─── Detalhes / Ações ────────────────────────────────────────────
  async function verDetalhes(id) {
    const orc = await window.pdv.orcamentos.getById(id);
    if (!orc) { Toast.show('Orçamento não encontrado', 'error'); return; }

    const hoje = new Date();
    const venc = new Date(orc.created_at);
    venc.setDate(venc.getDate() + (orc.validade_dias || 7));
    const expirado = orc.status === 'pendente' && venc < hoje;
    const status = expirado ? 'expirado' : orc.status;

    const badgeMap = {
      pendente:   `<span class="badge badge-yellow">Pendente</span>`,
      aprovado:   `<span class="badge badge-green">Aprovado</span>`,
      convertido: `<span class="badge" style="background:var(--accent-bg);color:var(--accent)">Convertido em venda</span>`,
      cancelado:  `<span class="badge badge-red">Cancelado</span>`,
      expirado:   `<span class="badge" style="background:var(--bg3);color:var(--text3)">Expirado</span>`,
    };

    const itensHtml = (orc.itens || []).map(i => `
<tr style="border-bottom:1px solid var(--border)">
  <td style="padding:8px">${i.produto_nome}</td>
  <td style="padding:8px;color:var(--text3);font-size:12px">${i.produto_sku||'—'}</td>
  <td style="padding:8px;text-align:center">${i.quantidade}</td>
  <td style="padding:8px;text-align:right">R$ ${fmtMoney(i.preco_unitario)}</td>
  <td style="padding:8px;text-align:right;font-weight:600;color:var(--accent)">R$ ${fmtMoney(i.total)}</td>
</tr>`).join('');

    const podeAcionar = orc.status !== 'cancelado' && orc.status !== 'convertido';

    Modal.open(`
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px">
  <div style="background:var(--bg3);border-radius:8px;padding:12px">
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Status</div>
    <div>${badgeMap[status] || orc.status}</div>
    <div style="font-size:11px;color:var(--text3);margin-top:4px">Criado em ${_fmtData(orc.created_at)}</div>
  </div>
  <div style="background:var(--bg3);border-radius:8px;padding:12px">
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Cliente</div>
    <div style="font-weight:600">${orc.cliente_nome || 'Sem cliente'}</div>
    <div style="font-size:11px;color:var(--text3)">${orc.cliente_telefone || ''}</div>
  </div>
  <div style="background:var(--bg3);border-radius:8px;padding:12px">
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Pagamento</div>
    <div style="font-weight:600">${_fmtForma(orc.forma_pagamento)}</div>
    <div style="font-size:11px;color:var(--text3)">Validade: ${orc.validade_dias} dias (até ${_fmtData(venc.toISOString())})</div>
  </div>
  <div style="background:var(--bg3);border-radius:8px;padding:12px">
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Total</div>
    <div class="font-syne" style="font-size:22px;font-weight:700;color:var(--accent)">R$ ${fmtMoney(orc.total)}</div>
    ${orc.desconto > 0 ? `<div style="font-size:11px;color:var(--red)">Desconto: R$ ${fmtMoney(orc.desconto)}</div>` : ''}
  </div>
</div>

${orc.observacao ? `<div style="background:var(--bg3);border-radius:8px;padding:10px;margin-bottom:16px;font-size:13px;color:var(--text2)">📝 ${orc.observacao}</div>` : ''}

<div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:8px">Itens</div>
<table style="width:100%;border-collapse:collapse;margin-bottom:16px">
  <thead>
    <tr style="border-bottom:2px solid var(--border)">
      <th style="text-align:left;padding:8px;font-size:11px;color:var(--text3)">Produto</th>
      <th style="text-align:left;padding:8px;font-size:11px;color:var(--text3)">SKU</th>
      <th style="text-align:center;padding:8px;font-size:11px;color:var(--text3)">Qtd</th>
      <th style="text-align:right;padding:8px;font-size:11px;color:var(--text3)">Unit.</th>
      <th style="text-align:right;padding:8px;font-size:11px;color:var(--text3)">Total</th>
    </tr>
  </thead>
  <tbody>${itensHtml}</tbody>
  <tfoot>
    <tr>
      <td colspan="4" style="padding:8px;text-align:right;font-weight:600">Total</td>
      <td style="padding:8px;text-align:right;font-weight:700;color:var(--accent);font-family:'Syne',sans-serif">R$ ${fmtMoney(orc.total)}</td>
    </tr>
  </tfoot>
</table>

<div class="modal-actions" style="gap:8px">
  ${podeAcionar ? `
  <button class="btn btn-primary" onclick="Orcamentos.converterEmVenda('${orc.id}');Modal.close()">🛒 Converter em Venda</button>
  <button class="btn btn-ghost" onclick="Orcamentos.cancelar('${orc.id}');Modal.close()">🗑️ Cancelar</button>
  ` : ''}
  <button class="btn btn-ghost" onclick="Orcamentos._imprimirOrcamento('${orc.id}')">🖨️ Imprimir</button>
  <button class="btn btn-ghost" onclick="Modal.close()">Fechar</button>
</div>`, `Orçamento #${orc.numero}`);
  }

  // ─── Converter em venda ───────────────────────────────────────────
  async function converterEmVenda(id) {
    const orc = await window.pdv.orcamentos.getById(id);
    if (!orc) { Toast.show('Orçamento não encontrado', 'error'); return; }
    if (orc.status === 'cancelado' || orc.status === 'convertido') {
      Toast.show('Este orçamento não pode ser convertido', 'error'); return;
    }

    // Navega para o PDV carregando os itens do orçamento
    App.navigate('pdv');
    await PDV.carregarDoOrcamento(orc);

    // Marca como convertido em background (após o operador finalizar a venda, o status será atualizado)
    Toast.show(`Orçamento #${orc.numero} carregado no PDV. Finalize a venda normalmente.`, 'success');
  }

  // ─── Cancelar ─────────────────────────────────────────────────────
  async function cancelar(id) {
    const ok = await window.pdv.app.confirm('Cancelar este orçamento?');
    if (!ok) return;
    await window.pdv.orcamentos.cancelar(id);
    Toast.show('Orçamento cancelado', 'success');
    load();
  }

  // ─── Impressão ────────────────────────────────────────────────────
  async function _imprimirOrcamento(id) {
    const orc = await window.pdv.orcamentos.getById(id);
    if (!orc) return;

    const hoje = new Date();
    const venc = new Date(orc.created_at);
    venc.setDate(venc.getDate() + (orc.validade_dias || 7));
    const config = await window.pdv.config.getAll();
    const empresa = config?.['auth.usuario']?.empresa_nome || '';

    const linhas = [
      { tipo: 'titulo',   texto: 'ORÇAMENTO' },
      { tipo: 'subtitulo',texto: empresa },
      { tipo: 'separador' },
      { tipo: 'par', label: 'Nº', valor: String(orc.numero) },
      { tipo: 'par', label: 'Data', valor: _fmtData(orc.created_at) },
      { tipo: 'par', label: 'Validade', valor: _fmtData(venc.toISOString()) },
      ...(orc.cliente_nome ? [{ tipo: 'par', label: 'Cliente', valor: orc.cliente_nome }] : []),
      { tipo: 'separador' },
    ];

    for (const item of orc.itens) {
      linhas.push({ tipo: 'item', nome: item.produto_nome, qtd: item.quantidade, preco: item.preco_unitario, total: item.total });
    }

    linhas.push(
      { tipo: 'separador' },
      { tipo: 'par', label: 'Subtotal', valor: `R$ ${fmtMoney(orc.subtotal)}` },
    );
    if (orc.desconto > 0) linhas.push({ tipo: 'par', label: 'Desconto', valor: `- R$ ${fmtMoney(orc.desconto)}` });
    linhas.push(
      { tipo: 'total', label: 'TOTAL', valor: `R$ ${fmtMoney(orc.total)}` },
      { tipo: 'par', label: 'Pagamento', valor: _fmtForma(orc.forma_pagamento) },
    );
    if (orc.observacao) linhas.push({ tipo: 'separador' }, { tipo: 'texto', texto: orc.observacao });
    linhas.push({ tipo: 'separador' }, { tipo: 'centro', texto: 'Orçamento válido até ' + _fmtData(venc.toISOString()) });

    try {
      await window.pdv.print.local({ tipo: 'orcamento', linhas });
    } catch {
      Toast.show('Impressora não configurada', 'error');
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────
  function _fmtData(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleDateString('pt-BR'); } catch { return iso; }
  }

  function _fmtForma(f) {
    return { dinheiro:'Dinheiro', pix:'PIX', credito:'Cartão Crédito', debito:'Cartão Débito',
             boleto:'Boleto', outros:'Outros', carteira:'Crédito Loja' }[f] || f || '—';
  }

  return {
    render, init, load,
    abrirNovo, fecharNovo, salvar,
    verDetalhes, converterEmVenda, cancelar,
    _onSearch, _onSearchKey, _showResults, _hideResults,
    _addItem, _incQty, _decQty, _setQty, _removeItem, _recalcTotals,
    _onClientSearch, _selecionarCliente, _limparCliente,
    _imprimirOrcamento,
  };
})();

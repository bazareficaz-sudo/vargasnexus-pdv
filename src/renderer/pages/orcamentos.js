// ─── Orçamentos ───────────────────────────────────────────────────
const Orcamentos = (() => {
  let _lista         = [];
  let _cart          = [];
  let _cliente       = null;
  let _modoNovo      = false;
  let _searchTimeout = null;
  let _cliTimeout    = null;
  let _periodoCustom = false;
  let _orcamentoEditando = null; // { id, numero } quando em modo edição

  // Navegação por teclado na busca de produto
  let _searchHighlight = -1;
  let _searchItems     = [];

  // Painel de qty/preço/desconto (similar ao PDV)
  let _qtyItem = null;

  // ─── Render principal ────────────────────────────────────────────
  function render() {
    return `<div id="orc-root">${_modoNovo ? _renderFormNovo() : _renderLista()}</div>`;
  }

  function init() {
    _modoNovo ? _initForm() : load();
  }

  // ─── Filtros de data ─────────────────────────────────────────────
  function _rangeParaPeriodo(periodo) {
    const hoje = new Date();
    const ini = d => { const x = new Date(d); x.setHours(0,0,0,0); return x; };
    const fim = d => { const x = new Date(d); x.setHours(23,59,59,999); return x; };
    if (periodo === 'hoje')  return { de: ini(hoje), ate: fim(hoje) };
    if (periodo === 'ontem') { const d = new Date(hoje); d.setDate(d.getDate()-1); return { de: ini(d), ate: fim(d) }; }
    if (periodo === '7dias') { const d = new Date(hoje); d.setDate(d.getDate()-6); return { de: ini(d), ate: fim(hoje) }; }
    if (periodo === 'mes')   { const d = new Date(hoje.getFullYear(), hoje.getMonth(), 1); return { de: ini(d), ate: fim(hoje) }; }
    return null; // sem filtro de data (todos / período custom)
  }

  // ─── Lista ───────────────────────────────────────────────────────
  function _renderLista() {
    return `
<div class="page-header">
  <div><div class="page-title">Orçamentos</div></div>
  <div class="page-actions" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
    <input class="input" id="orc-busca" type="text" placeholder="🔍 Cliente ou número..."
      style="min-width:160px" oninput="Orcamentos.load()">
    <select class="input" id="orc-status" onchange="Orcamentos.load()" style="width:auto">
      <option value="">Todos status</option>
      <option value="pendente">Pendente</option>
      <option value="aprovado">Aprovado</option>
      <option value="convertido">Convertido</option>
      <option value="cancelado">Cancelado</option>
    </select>
    <select class="input" id="orc-periodo" onchange="Orcamentos.onPeriodoChange()" style="width:auto">
      <option value="hoje">Hoje</option>
      <option value="ontem">Ontem</option>
      <option value="7dias">7 dias</option>
      <option value="mes">Mês corrente</option>
      <option value="todos">Todos</option>
      <option value="periodo">Período...</option>
    </select>
    <span id="orc-periodo-custom" style="display:none;gap:4px;align-items:center">
      <input class="input" id="orc-de" type="date" onchange="Orcamentos.load()" style="width:140px">
      <span style="color:var(--text3)">até</span>
      <input class="input" id="orc-ate" type="date" onchange="Orcamentos.load()" style="width:140px">
    </span>
    <button class="btn btn-primary" onclick="Orcamentos.abrirNovo()">+ Novo Orçamento</button>
  </div>
</div>
<div id="orc-lista" style="padding:0 24px 24px">
  <div style="color:var(--text3);text-align:center;padding:40px">Carregando...</div>
</div>`;
  }

  function onPeriodoChange() {
    const v = document.getElementById('orc-periodo')?.value;
    const custom = document.getElementById('orc-periodo-custom');
    if (custom) custom.style.display = v === 'periodo' ? 'flex' : 'none';
    if (v !== 'periodo') load();
  }

  async function load() {
    const busca   = document.getElementById('orc-busca')?.value?.trim() || '';
    const status  = document.getElementById('orc-status')?.value || '';
    const periodo = document.getElementById('orc-periodo')?.value || 'hoje';

    // Buscar local e cloud em paralelo
    const [locais, cloud] = await Promise.all([
      window.pdv.orcamentos.listar({ busca, status }),
      window.pdv.orcamentos.listarCloud({ status }),
    ]);

    // Mesclar: cloud sobrescreve locais pelo numero (prioriza local se tiver remote_id igual)
    const mapa = new Map();
    for (const o of cloud) mapa.set(String(o.numero), { ...o, _origem: 'cloud' });
    for (const o of locais) mapa.set(String(o.numero), { ...o, _origem: o.remote_id ? 'sync' : 'local' });
    let lista = Array.from(mapa.values());

    // Filtro de busca para os cloud (db local já filtrou)
    if (busca) {
      const q = busca.toLowerCase();
      lista = lista.filter(o =>
        (o.cliente_nome || '').toLowerCase().includes(q) ||
        String(o.numero).includes(q)
      );
    }

    // Filtro de data
    let de = null, ate = null;
    if (periodo === 'periodo') {
      const dv = document.getElementById('orc-de')?.value;
      const av = document.getElementById('orc-ate')?.value;
      if (dv) de  = new Date(dv + 'T00:00:00');
      if (av) ate = new Date(av + 'T23:59:59');
    } else if (periodo !== 'todos') {
      const r = _rangeParaPeriodo(periodo);
      if (r) { de = r.de; ate = r.ate; }
    }
    if (de || ate) {
      lista = lista.filter(o => {
        const d = new Date(o.created_at);
        if (de  && d < de)  return false;
        if (ate && d > ate) return false;
        return true;
      });
    }

    // Ordenar por data desc
    lista.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    _lista = lista;
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
      const st = expirado ? 'expirado' : o.status;
      const badge = { pendente:'<span class="badge badge-yellow">Pendente</span>', aprovado:'<span class="badge badge-green">Aprovado</span>', convertido:'<span class="badge" style="background:var(--accent-bg);color:var(--accent)">Convertido</span>', cancelado:'<span class="badge badge-red">Cancelado</span>', expirado:'<span class="badge" style="background:var(--bg3);color:var(--text3)">Expirado</span>' }[st] || `<span class="badge">${st}</span>`;
      const isCloud = o._origem === 'cloud'; // orçamento de outro terminal (sem dados locais)
      const waBtn = o.cliente_telefone
        ? `WA.abrirModal('Enviar orçamento via WhatsApp','${(o.cliente_telefone||'').replace(/'/g,"\\'")}','orcamento','${o.id}')`
        : `WA.abrirModalCapturaCliente('orcamento','${o.id}','${(o.cliente_nome||'').replace(/'/g,"\\'")}')`;
      return `
<tr onclick="Orcamentos.verDetalhes('${o.id}')" style="cursor:pointer">
  <td style="font-weight:700;font-family:'Syne',sans-serif">
    #${o.numero}${isCloud?'<br><span style="font-size:9px;color:var(--text3);font-weight:400">outro terminal</span>':''}
  </td>
  <td style="font-size:12px;color:var(--text3)">${_fmtData(o.created_at)}</td>
  <td>${o.cliente_nome || '<span style="color:var(--text3)">—</span>'}${o.vendedor_nome&&isCloud?`<br><span style="font-size:10px;color:var(--text3)">${o.vendedor_nome}</span>`:''}</td>
  <td style="text-align:right;font-weight:600;color:var(--accent)">R$ ${fmtMoney(o.total)}</td>
  <td>${badge}</td>
  <td style="font-size:12px;color:${expirado?'var(--red)':'var(--text3)'}">${o.status==='pendente'||o.status==='aprovado'?_fmtData(venc.toISOString()):'—'}</td>
  <td onclick="event.stopPropagation()"><div style="display:flex;gap:4px">
    <button class="btn btn-ghost btn-sm" onclick="Orcamentos.verDetalhes('${o.id}')">👁️</button>
    <button class="btn btn-ghost btn-sm" style="color:#25D366" title="Enviar por WhatsApp" onclick="${waBtn}">${WA_ICON}</button>
    ${!isCloud&&(o.status==='pendente'||o.status==='aprovado')?`<button class="btn btn-ghost btn-sm" title="Editar orçamento" onclick="Orcamentos.abrirEdicao('${o.id}')">✏️</button>`:''}
    ${!isCloud&&(o.status==='pendente'||o.status==='aprovado')?`<button class="btn btn-ghost btn-sm" title="Converter em venda" onclick="Orcamentos.converterEmVenda('${o.id}')">🛒</button>`:''}
    ${!isCloud&&o.status!=='cancelado'&&o.status!=='convertido'?`<button class="btn btn-ghost btn-sm" onclick="Orcamentos.cancelar('${o.id}')">🗑️</button>`:''}
  </div></td>
</tr>`;
    }).join('');
    el.innerHTML = `
<table style="width:100%;border-collapse:collapse">
  <thead><tr style="border-bottom:2px solid var(--border)">
    <th style="text-align:left;padding:10px 8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Nº</th>
    <th style="text-align:left;padding:10px 8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Data</th>
    <th style="text-align:left;padding:10px 8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Cliente</th>
    <th style="text-align:right;padding:10px 8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Total</th>
    <th style="padding:10px 8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Status</th>
    <th style="padding:10px 8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Válido até</th>
    <th style="padding:10px 8px"></th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>`;
  }

  // ─── Formulário novo ─────────────────────────────────────────────
  function abrirNovo() {
    _cart = []; _cliente = null; _qtyItem = null;
    _searchHighlight = -1; _searchItems = [];
    _orcamentoEditando = null;
    _modoNovo = true;
    document.getElementById('orc-root').innerHTML = _renderFormNovo();
    _initForm();
  }

  async function abrirEdicao(id) {
    const orc = await window.pdv.orcamentos.getById(id);
    if (!orc) { Toast.show('Orçamento não encontrado', 'error'); return; }
    if (orc.status === 'cancelado' || orc.status === 'convertido') {
      Toast.show('Este orçamento não pode ser editado', 'error'); return;
    }
    Modal.close();
    _orcamentoEditando = { id: orc.id, numero: orc.numero };
    _cliente = orc.cliente_id ? { id: orc.cliente_id, nome: orc.cliente_nome, telefone: orc.cliente_telefone } : null;
    _cart = (orc.itens || []).map(i => ({
      produto_id: i.produto_id, produto_nome: i.produto_nome,
      produto_sku: i.produto_sku || null, emoji: i.emoji || '📦',
      quantidade: i.quantidade, preco_unitario: i.preco_unitario,
      desconto: i.desconto || 0, total: i.total,
    }));
    _qtyItem = null; _searchHighlight = -1; _searchItems = [];
    _modoNovo = true;
    document.getElementById('orc-root').innerHTML = _renderFormNovo();
    _initForm();
    // Preencher campos da direita com dados do orçamento
    setTimeout(() => {
      const validadeEl = document.getElementById('orc-validade');
      if (validadeEl) validadeEl.value = orc.validade_dias || 7;
      const descontoEl = document.getElementById('orc-desconto');
      if (descontoEl) descontoEl.value = orc.desconto || 0;
      const obsEl = document.getElementById('orc-obs');
      if (obsEl) obsEl.value = orc.observacao || '';
      if (orc.forma_pagamento) _selecionarPagamento(orc.forma_pagamento);
      _recalcTotals();
    }, 50);
  }

  function fecharNovo() {
    _orcamentoEditando = null;
    _modoNovo = false;
    document.getElementById('orc-root').innerHTML = _renderLista();
    load();
  }

  function _renderFormNovo() {
    const titulo = _orcamentoEditando ? `Editar Orçamento #${_orcamentoEditando.numero}` : 'Novo Orçamento';
    const btnLabel = _orcamentoEditando ? '💾 Salvar Edição' : '💾 Salvar Orçamento';
    return `
<div class="page-header">
  <div style="display:flex;align-items:center;gap:12px">
    <button class="btn btn-ghost btn-sm" onclick="Orcamentos.fecharNovo()">← Voltar</button>
    <div class="page-title">${titulo}</div>
  </div>
  <div class="page-actions">
    <button class="btn btn-primary" onclick="Orcamentos.salvar()">${btnLabel}</button>
  </div>
</div>

<div style="display:grid;grid-template-columns:1fr 340px;gap:0;height:calc(100vh - 108px);overflow:hidden">

  <!-- ── Esquerda: busca + itens ── -->
  <div style="display:flex;flex-direction:column;border-right:1px solid var(--border);overflow:hidden">

    <!-- Busca de produto -->
    <div style="padding:14px 16px 0;flex-shrink:0;position:relative">
      <input class="input input-lg" id="orc-prod-search" autocomplete="off"
        placeholder="🔍 Nome, SKU ou EAN — ↑↓ navegar · Enter selecionar · Esc fechar"
        oninput="Orcamentos._onSearch(this.value)"
        onkeydown="Orcamentos._onSearchKey(event)">

      <!-- Painel qty / preço / desconto por item (aparece após selecionar produto) -->
      <div id="orc-qty-panel" style="display:none;flex-direction:column;gap:0;border-bottom:1px solid var(--border);background:var(--bg2);margin-top:10px;border-radius:var(--radius-lg);border:1px solid var(--accent)">
        <div style="padding:10px 14px 0">
          <div id="oqp-nome" style="font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--accent)"></div>
          <div id="oqp-info" style="font-size:11px;color:var(--text3);margin-top:2px"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;padding:10px 14px">
          <div>
            <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Quantidade</label>
            <input class="input" id="oqp-qty" type="number" min="0.001" step="1" value="1"
              style="font-size:18px;font-weight:700;text-align:center"
              onkeydown="Orcamentos._qpKey(event,'qty')">
          </div>
          <div>
            <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Preço Unit. (R$)</label>
            <input class="input" id="oqp-preco" type="number" min="0" step="0.01"
              style="font-size:18px;font-weight:700;text-align:center"
              oninput="Orcamentos._qpCalcDesc()"
              onkeydown="Orcamentos._qpKey(event,'preco')">
          </div>
          <div>
            <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Desc. item (R$)</label>
            <input class="input" id="oqp-desc" type="number" min="0" step="0.01" value="0"
              style="font-size:18px;font-weight:700;text-align:center;color:var(--red)"
              onkeydown="Orcamentos._qpKey(event,'desc')">
          </div>
        </div>
        <!-- Sugestões de desconto por % -->
        <div style="padding:0 14px 6px;display:flex;gap:6px;align-items:center">
          <span style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px">Sugerir:</span>
          ${[5,10,15,20].map(p => `<button onclick="Orcamentos._sugerirDescItem(${p})"
            style="padding:3px 10px;border-radius:12px;border:1px solid var(--border2);background:var(--bg3);cursor:pointer;font-size:12px;color:var(--text2);transition:.15s"
            onmouseenter="this.style.borderColor='var(--accent)';this.style.color='var(--accent)'"
            onmouseleave="this.style.borderColor='var(--border2)';this.style.color='var(--text2)'"
            title="Aplicar ${p}% de desconto no item">−${p}%</button>`).join('')}
          <span id="oqp-total-label" style="margin-left:auto;font-weight:700;font-family:'Syne',sans-serif;color:var(--accent);font-size:16px"></span>
        </div>
        <div style="display:flex;gap:8px;padding:0 14px 12px">
          <button class="btn btn-ghost btn-sm" style="flex:1" onclick="Orcamentos._fecharQtyPanel()">ESC · Cancelar</button>
          <button class="btn btn-primary" style="flex:2" onclick="Orcamentos._confirmarItem()">✓ Adicionar [Enter]</button>
        </div>
      </div>

      <!-- Resultados de busca -->
      <div id="orc-search-results" style="
        display:none;position:absolute;left:16px;right:16px;top:calc(100% + 4px);
        background:var(--bg2);border:1px solid var(--border2);border-radius:var(--radius-lg);
        z-index:50;max-height:380px;overflow-y:auto;box-shadow:var(--shadow-lg)
      "></div>
    </div>

    <!-- Cart -->
    <div style="flex:1;overflow-y:auto;padding:12px 16px" id="orc-cart">
      <div style="color:var(--text3);text-align:center;padding:40px;font-size:14px">
        Adicione produtos acima<br><span style="font-size:11px;opacity:.6">Use ↑↓ Enter para navegar sem o mouse</span>
      </div>
    </div>
  </div>

  <!-- ── Direita: condições do orçamento ── -->
  <div style="display:flex;flex-direction:column;overflow-y:auto;background:var(--bg2);border-left:none">

    <!-- Cliente -->
    <div style="padding:14px 16px;border-bottom:1px solid var(--border)">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:6px">Cliente (opcional)</div>
      <div id="orc-cliente-box" style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:6px;min-height:38px">
        <div style="color:var(--text3);font-size:13px">Sem cliente</div>
      </div>
      <div style="position:relative">
        <input class="input" id="orc-cli-search" placeholder="🔍 Buscar cliente..."
          oninput="Orcamentos._onClientSearch(this.value)">
        <div id="orc-cli-results" style="
          display:none;position:absolute;left:0;right:0;top:calc(100% + 2px);
          background:var(--bg2);border:1px solid var(--border2);border-radius:8px;
          z-index:60;max-height:200px;overflow-y:auto;box-shadow:var(--shadow-lg)
        "></div>
      </div>
    </div>

    <!-- Forma de pagamento (grid de botões) -->
    <div style="padding:14px 16px;border-bottom:1px solid var(--border)">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:8px">Forma de Pagamento</div>
      <div id="orc-pagamento-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${[
          ['dinheiro','💵','Dinheiro'],
          ['pix','⚡','PIX'],
          ['credito','💳','Crédito'],
          ['debito','💳','Débito'],
          ['boleto','📄','Boleto'],
          ['outros','📋','A Combinar'],
        ].map(([v,ic,la]) => `
        <button class="orc-pay-btn${v==='dinheiro'?' active':''}" data-pay="${v}"
          onclick="Orcamentos._selecionarPagamento('${v}')"
          style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;
            border:1px solid var(--border2);background:var(--bg3);cursor:pointer;
            font-size:13px;color:var(--text2);transition:.15s;text-align:left;
            ${v==='dinheiro'?'border-color:var(--accent);background:var(--accent-bg);color:var(--accent);':''}"
          onmouseenter="if(!this.classList.contains('active')){this.style.borderColor='var(--accent)';this.style.color='var(--accent)'}"
          onmouseleave="if(!this.classList.contains('active')){this.style.borderColor='var(--border2)';this.style.color='var(--text2)'}">
          <span>${ic}</span><span style="font-weight:500">${la}</span>
        </button>`).join('')}
      </div>
    </div>

    <!-- Condição de pagamento -->
    <div style="padding:14px 16px;border-bottom:1px solid var(--border)">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:8px">Condição</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px" id="orc-cond-grid">
        ${[['avista','À Vista'],['30','30 dias'],['3060','30/60'],['306090','30/60/90'],['personalizado','Personalizada']].map(([v,la])=>`
        <button class="orc-cond-btn${v==='avista'?' active':''}" data-cond="${v}"
          onclick="Orcamentos._selecionarCondicao('${v}')"
          style="padding:5px 12px;border-radius:20px;border:1px solid var(--border2);
            background:var(--bg3);cursor:pointer;font-size:12px;color:var(--text2);transition:.15s;
            ${v==='avista'?'border-color:var(--accent);background:var(--accent-bg);color:var(--accent);':''}">
          ${la}
        </button>`).join('')}
      </div>
      <div id="orc-cond-personalizado" style="display:none;margin-top:8px">
        <input class="input" id="orc-cond-texto" placeholder="Ex: 50% entrada + 30/60 dias"
          style="font-size:13px">
      </div>
    </div>

    <!-- Validade + Desconto geral -->
    <div style="padding:14px 16px;border-bottom:1px solid var(--border)">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
        <div>
          <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Validade (dias)</label>
          <input class="input" id="orc-validade" type="number" min="1" max="365" value="7" style="text-align:center">
        </div>
        <div>
          <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Desc. Total (R$)</label>
          <input class="input" id="orc-desconto" type="number" min="0" step="0.01" value="0"
            oninput="Orcamentos._recalcTotals()">
        </div>
      </div>
      <!-- Sugestões de desconto global -->
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <span style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;align-self:center">Brigar:</span>
        ${[3,5,8,10,15].map(p=>`
        <button onclick="Orcamentos._sugerirDescGlobal(${p})"
          style="padding:3px 10px;border-radius:12px;border:1px solid var(--border2);background:var(--bg3);
            cursor:pointer;font-size:12px;color:var(--text2);transition:.15s"
          onmouseenter="this.style.borderColor='var(--green)';this.style.color='var(--green)'"
          onmouseleave="this.style.borderColor='var(--border2)';this.style.color='var(--text2)'"
          title="Desconto de ${p}% sobre o total">−${p}%</button>`).join('')}
        <button onclick="Orcamentos._sugerirDescGlobal(0)"
          style="padding:3px 10px;border-radius:12px;border:1px solid var(--border2);background:var(--bg3);
            cursor:pointer;font-size:12px;color:var(--text3);transition:.15s"
          onmouseenter="this.style.borderColor='var(--red)';this.style.color='var(--red)'"
          onmouseleave="this.style.borderColor='var(--border2)';this.style.color='var(--text3)'"
          title="Remover desconto">✕ Sem desc.</button>
      </div>
    </div>

    <!-- Observação -->
    <div style="padding:14px 16px;border-bottom:1px solid var(--border)">
      <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Observação</label>
      <textarea class="input" id="orc-obs" rows="2" style="resize:none;font-size:13px"
        placeholder="Condições especiais, prazo de entrega, garantias..."></textarea>
    </div>

    <!-- Totais -->
    <div style="padding:14px 16px;border-bottom:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:13px">
        <span style="color:var(--text3)">Subtotal</span>
        <span id="orc-tot-sub">R$ 0,00</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:4px;font-size:13px">
        <span style="color:var(--text3)">Desc. itens</span>
        <span id="orc-tot-desc-item" style="color:var(--red)">− R$ 0,00</span>
      </div>
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:13px">
        <span style="color:var(--text3)">Desc. geral</span>
        <span id="orc-tot-desc" style="color:var(--red)">− R$ 0,00</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:22px;font-weight:700;font-family:'Syne',sans-serif;color:var(--accent)">
        <span>Total</span>
        <span id="orc-tot">R$ 0,00</span>
      </div>
      <div id="orc-economy" style="text-align:right;font-size:11px;color:var(--green);margin-top:2px;display:none">
        Cliente economiza R$ <span id="orc-economy-val">0,00</span>
      </div>
    </div>

    <div style="padding:14px 16px">
      <button class="btn btn-primary btn-lg" style="width:100%" onclick="Orcamentos.salvar()">${_orcamentoEditando ? '💾 Salvar Edição' : '💾 Salvar Orçamento'}</button>
    </div>
  </div>
</div>

<style>
.orc-pay-btn.active { border-color:var(--accent)!important;background:var(--accent-bg)!important;color:var(--accent)!important;font-weight:600 }
.orc-cond-btn.active { border-color:var(--accent)!important;background:var(--accent-bg)!important;color:var(--accent)!important;font-weight:600 }
#orc-search-results .orc-si { cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s }
#orc-search-results .orc-si:last-child { border-bottom:none }
#orc-search-results .orc-si:hover, #orc-search-results .orc-si.highlighted { background:var(--bg3) }
</style>`;
  }

  function _initForm() {
    // Se editando, preenche carrinho e cliente já carregados no estado
    if (_cart.length) { _renderCart(); _recalcTotals(); }
    if (_cliente) {
      const box = document.getElementById('orc-cliente-box');
      if (box) box.innerHTML = `
<div style="display:flex;justify-content:space-between;align-items:center">
  <div>
    <div style="font-weight:600;font-size:13px">${_cliente.nome}</div>
    <div style="font-size:11px;color:var(--text3)">${_cliente.telefone||'Sem telefone'}</div>
  </div>
  <button onclick="Orcamentos._limparCliente()"
    style="background:none;border:none;cursor:pointer;color:var(--text3);font-size:14px">✕</button>
</div>`;
    }
    document.getElementById('orc-prod-search')?.focus();
  }

  // ─── Busca de produto ─────────────────────────────────────────────
  function _onSearch(val) {
    clearTimeout(_searchTimeout);
    const box = document.getElementById('orc-search-results');
    if (!val.trim()) { if (box) box.style.display = 'none'; return; }
    _searchTimeout = setTimeout(async () => {
      _searchItems = await window.pdv.produtos.buscar(val);
      _searchHighlight = -1;
      _renderSearchResults();
    }, 150);
  }

  function _renderSearchResults() {
    const box = document.getElementById('orc-search-results');
    if (!box) return;
    if (!_searchItems.length) { box.style.display = 'none'; return; }
    box.innerHTML = `<table style="width:100%;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid var(--border);background:var(--bg3)">
        <th style="padding:6px 10px;font-size:10px;color:var(--text3);text-transform:uppercase;text-align:left;width:80px">SKU</th>
        <th style="padding:6px 10px;font-size:10px;color:var(--text3);text-transform:uppercase;text-align:left">Produto</th>
        <th style="padding:6px 10px;font-size:10px;color:var(--text3);text-transform:uppercase;text-align:left;width:110px">Marca</th>
        <th style="padding:6px 10px;font-size:10px;color:var(--text3);text-transform:uppercase;text-align:center;width:80px">Estoque</th>
        <th style="padding:6px 10px;font-size:10px;color:var(--text3);text-transform:uppercase;text-align:right;width:100px">Preço</th>
      </tr></thead>
      <tbody>
      ${_searchItems.slice(0,30).map((p,i)=>{
        const estoqueHtml = p.estoque <= 0
          ? `<span style="color:var(--red)">❌ 0</span>`
          : p.estoque <= 5
            ? `<span style="color:var(--yellow)">⚠️ ${p.estoque}</span>`
            : `<span style="color:var(--green)">${p.estoque}</span>`;
        return `
      <tr class="orc-si${i===_searchHighlight?' highlighted':''}" id="orc-si-${i}"
        onclick="Orcamentos._selecionarProduto(${i})">
        <td style="padding:8px 10px;font-size:11px;color:var(--text3);white-space:nowrap">${p.sku||'—'}</td>
        <td style="padding:8px 10px">
          <span style="font-size:14px;margin-right:4px">${p.emoji||'📦'}</span>
          <span style="font-weight:500;font-size:13px">${p.nome}</span>
        </td>
        <td style="padding:8px 10px;font-size:12px;color:var(--text2)">${p.marca||'—'}</td>
        <td style="padding:8px 10px;text-align:center;font-size:12px">${estoqueHtml}</td>
        <td style="padding:8px 10px;text-align:right;font-weight:700;color:var(--accent);font-family:'Syne',sans-serif;white-space:nowrap">
          R$ ${fmtMoney(p.preco_venda)}
        </td>
      </tr>`;}).join('')}
      </tbody></table>`;
    box.style.display = 'block';
  }

  function _onSearchKey(e) {
    // Se o painel qty estiver visível, redirecionar
    if (document.getElementById('orc-qty-panel')?.style.display !== 'none') {
      if (e.key === 'Escape') { _fecharQtyPanel(); e.preventDefault(); }
      return;
    }

    const items = document.querySelectorAll('#orc-search-results .orc-si');
    if (!items.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _searchHighlight = Math.min(_searchHighlight + 1, items.length - 1);
      _highlightItem(items);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (_searchHighlight <= 0) { _searchHighlight = -1; items.forEach(el => el.classList.remove('highlighted')); return; }
      _searchHighlight = Math.max(_searchHighlight - 1, 0);
      _highlightItem(items);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (_searchHighlight >= 0 && _searchItems[_searchHighlight]) {
        _selecionarProduto(_searchHighlight);
      } else if (_searchItems.length === 1) {
        _selecionarProduto(0);
      }
    } else if (e.key === 'Escape') {
      document.getElementById('orc-search-results').style.display = 'none';
      _searchHighlight = -1;
    }
  }

  function _highlightItem(items) {
    items.forEach((el, i) => el.classList.toggle('highlighted', i === _searchHighlight));
    items[_searchHighlight]?.scrollIntoView({ block: 'nearest' });
  }

  // Seleciona produto e abre painel qty/preço
  function _selecionarProduto(idx) {
    const p = _searchItems[idx];
    if (!p) return;
    _qtyItem = p;
    document.getElementById('orc-search-results').style.display = 'none';

    // Preenche painel
    document.getElementById('oqp-nome').textContent = `${p.emoji||'📦'} ${p.nome}`;
    document.getElementById('oqp-info').textContent = `SKU: ${p.sku||'—'} · Preço tabela: R$ ${fmtMoney(p.preco_venda)}`;
    document.getElementById('oqp-qty').value = '1';
    document.getElementById('oqp-preco').value = p.preco_venda.toFixed(2);
    document.getElementById('oqp-desc').value = '0';
    document.getElementById('oqp-total-label').textContent = `R$ ${fmtMoney(p.preco_venda)}`;

    const panel = document.getElementById('orc-qty-panel');
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    document.getElementById('oqp-qty').focus();
    document.getElementById('oqp-qty').select();
  }

  // Navegação no painel qty/preço
  function _qpKey(e, campo) {
    if (e.key === 'Escape') { _fecharQtyPanel(); e.preventDefault(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (campo === 'qty') { document.getElementById('oqp-preco').focus(); document.getElementById('oqp-preco').select(); }
      else if (campo === 'preco') { document.getElementById('oqp-desc').focus(); document.getElementById('oqp-desc').select(); }
      else { _confirmarItem(); }
    }
    if (e.key === 'Tab' && campo === 'qty') { e.preventDefault(); document.getElementById('oqp-preco').focus(); document.getElementById('oqp-preco').select(); }
    if (e.key === 'Tab' && campo === 'preco') { e.preventDefault(); document.getElementById('oqp-desc').focus(); document.getElementById('oqp-desc').select(); }
    if (e.key === 'Tab' && campo === 'desc') { e.preventDefault(); _confirmarItem(); }
    // Atualiza total ao digitar
    if (['qty','preco','desc'].includes(campo)) setTimeout(_qpCalcDesc, 0);
  }

  function _qpCalcDesc() {
    const qty   = parseFloat(document.getElementById('oqp-qty')?.value) || 1;
    const preco = parseFloat(document.getElementById('oqp-preco')?.value) || 0;
    const desc  = parseFloat(document.getElementById('oqp-desc')?.value) || 0;
    const tot = Math.max(0, qty * preco - desc);
    const lbl = document.getElementById('oqp-total-label');
    if (lbl) lbl.textContent = `R$ ${fmtMoney(tot)}`;
  }

  function _sugerirDescItem(pct) {
    if (!_qtyItem) return;
    const preco = parseFloat(document.getElementById('oqp-preco')?.value) || _qtyItem.preco_venda;
    const qty   = parseFloat(document.getElementById('oqp-qty')?.value) || 1;
    const desc  = parseFloat(((preco * qty * pct) / 100).toFixed(2));
    const el = document.getElementById('oqp-desc');
    if (el) { el.value = desc; _qpCalcDesc(); }
  }

  function _fecharQtyPanel() {
    _qtyItem = null;
    const panel = document.getElementById('orc-qty-panel');
    if (panel) panel.style.display = 'none';
    document.getElementById('orc-prod-search').value = '';
    document.getElementById('orc-prod-search').focus();
  }

  function _confirmarItem() {
    if (!_qtyItem) return;
    const qty   = parseFloat(document.getElementById('oqp-qty')?.value);
    const preco = parseFloat(document.getElementById('oqp-preco')?.value) || _qtyItem.preco_venda;
    const desc  = parseFloat(document.getElementById('oqp-desc')?.value) || 0;

    if (!qty || qty <= 0) { Toast.show('Quantidade inválida', 'error'); document.getElementById('oqp-qty').focus(); return; }

    const total = Math.max(0, qty * preco - desc);
    const existing = _cart.find(i => i.produto_id === _qtyItem.id);
    if (existing) {
      existing.quantidade += qty;
      existing.desconto   += desc;
      existing.total       = existing.quantidade * existing.preco_unitario - existing.desconto;
    } else {
      _cart.push({
        produto_id: _qtyItem.id, produto_nome: _qtyItem.nome,
        produto_sku: _qtyItem.sku || null, unidade: _qtyItem.unidade || 'UN',
        emoji: _qtyItem.emoji || '📦',
        quantidade: qty, preco_unitario: preco, desconto: desc, total,
      });
    }
    _fecharQtyPanel();
    _renderCart();
    _recalcTotals();
  }

  // ─── Cart ─────────────────────────────────────────────────────────
  function _renderCart() {
    const el = document.getElementById('orc-cart');
    if (!el) return;
    if (!_cart.length) {
      el.innerHTML = `<div style="color:var(--text3);text-align:center;padding:40px;font-size:14px">
        Adicione produtos acima<br><span style="font-size:11px;opacity:.6">Use ↑↓ Enter para navegar sem o mouse</span></div>`;
      return;
    }
    el.innerHTML = _cart.map((item, idx) => `
<div style="background:var(--bg2);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px;display:flex;align-items:center;gap:10px">
  <span style="font-size:20px;flex-shrink:0">${item.emoji||'📦'}</span>
  <div style="flex:1;min-width:0">
    <div style="font-weight:500;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.produto_nome}</div>
    <div style="font-size:11px;color:var(--text3)">
      ${item.produto_sku||''} · R$ ${fmtMoney(item.preco_unitario)}/un
      ${item.desconto>0?`<span style="color:var(--red)"> · desc. R$ ${fmtMoney(item.desconto)}</span>`:''}
    </div>
  </div>
  <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
    <button onclick="Orcamentos._decQty(${idx})"
      style="width:24px;height:24px;border-radius:6px;background:var(--bg3);border:1px solid var(--border2);cursor:pointer;font-size:14px">−</button>
    <input type="number" value="${item.quantidade}" min="0.001" step="1"
      style="width:52px;text-align:center;font-size:14px;font-weight:600;border:1px solid var(--border2);border-radius:6px;background:var(--bg3);color:var(--text);padding:2px 4px"
      oninput="Orcamentos._setQty(${idx},this.value)">
    <button onclick="Orcamentos._incQty(${idx})"
      style="width:24px;height:24px;border-radius:6px;background:var(--bg3);border:1px solid var(--border2);cursor:pointer;font-size:14px">+</button>
  </div>
  <div style="font-weight:700;color:var(--accent);font-family:'Syne',sans-serif;min-width:72px;text-align:right">
    R$ ${fmtMoney(item.total)}
  </div>
  <button onclick="Orcamentos._removeItem(${idx})"
    style="color:var(--text3);cursor:pointer;padding:4px;border-radius:4px;border:none;background:transparent;font-size:14px">✕</button>
</div>`).join('');
  }

  function _incQty(idx) { _cart[idx].quantidade += 1; _cart[idx].total = _cart[idx].quantidade * _cart[idx].preco_unitario - _cart[idx].desconto; _renderCart(); _recalcTotals(); }
  function _decQty(idx) { if (_cart[idx].quantidade <= 1) { _removeItem(idx); return; } _cart[idx].quantidade -= 1; _cart[idx].total = _cart[idx].quantidade * _cart[idx].preco_unitario - _cart[idx].desconto; _renderCart(); _recalcTotals(); }
  function _setQty(idx, val) { const q = parseFloat(val)||0; if (q<=0) { _removeItem(idx); return; } _cart[idx].quantidade=q; _cart[idx].total=q*_cart[idx].preco_unitario-_cart[idx].desconto; _recalcTotals(); }
  function _removeItem(idx) { _cart.splice(idx,1); _renderCart(); _recalcTotals(); }

  function _recalcTotals() {
    const bruto      = _cart.reduce((s,i) => s + i.quantidade * i.preco_unitario, 0);
    const descItens  = _cart.reduce((s,i) => s + (i.desconto||0), 0);
    const subtotal   = bruto - descItens;
    const descGeral  = parseFloat(document.getElementById('orc-desconto')?.value) || 0;
    const total      = Math.max(0, subtotal - descGeral);
    const totalDesc  = descItens + descGeral;

    const set = (id, txt) => { const e=document.getElementById(id); if(e) e.textContent=txt; };
    set('orc-tot-sub',      `R$ ${fmtMoney(bruto)}`);
    set('orc-tot-desc-item',`− R$ ${fmtMoney(descItens)}`);
    set('orc-tot-desc',     `− R$ ${fmtMoney(descGeral)}`);
    set('orc-tot',          `R$ ${fmtMoney(total)}`);

    const econEl = document.getElementById('orc-economy');
    const econVal = document.getElementById('orc-economy-val');
    if (econEl && econVal) {
      if (totalDesc > 0) { econEl.style.display = 'block'; econVal.textContent = fmtMoney(totalDesc); }
      else econEl.style.display = 'none';
    }
  }

  // ─── Desconto global sugerido ─────────────────────────────────────
  function _sugerirDescGlobal(pct) {
    const bruto = _cart.reduce((s,i) => s + i.quantidade * i.preco_unitario, 0);
    const descItens = _cart.reduce((s,i) => s + (i.desconto||0), 0);
    const subtotal = bruto - descItens;
    const desc = parseFloat(((subtotal * pct) / 100).toFixed(2));
    const el = document.getElementById('orc-desconto');
    if (el) { el.value = pct === 0 ? '0' : desc; _recalcTotals(); }
  }

  // ─── Pagamento + Condição ─────────────────────────────────────────
  function _selecionarPagamento(val) {
    document.querySelectorAll('.orc-pay-btn').forEach(b => {
      const active = b.dataset.pay === val;
      b.classList.toggle('active', active);
      b.style.borderColor   = active ? 'var(--accent)' : 'var(--border2)';
      b.style.background    = active ? 'var(--accent-bg)' : 'var(--bg3)';
      b.style.color         = active ? 'var(--accent)' : 'var(--text2)';
    });
  }

  function _selecionarCondicao(val) {
    document.querySelectorAll('.orc-cond-btn').forEach(b => {
      const active = b.dataset.cond === val;
      b.classList.toggle('active', active);
      b.style.borderColor = active ? 'var(--accent)' : 'var(--border2)';
      b.style.background  = active ? 'var(--accent-bg)' : 'var(--bg3)';
      b.style.color       = active ? 'var(--accent)' : 'var(--text2)';
    });
    const box = document.getElementById('orc-cond-personalizado');
    if (box) box.style.display = val === 'personalizado' ? 'block' : 'none';
  }

  function _getCondicaoTexto() {
    const btn = document.querySelector('.orc-cond-btn.active');
    if (!btn) return 'À Vista';
    const val = btn.dataset.cond;
    if (val === 'personalizado') return document.getElementById('orc-cond-texto')?.value?.trim() || 'Personalizada';
    return { avista:'À Vista', '30':'30 dias', '3060':'30/60 dias', '306090':'30/60/90 dias' }[val] || val;
  }

  function _getForma() {
    return document.querySelector('.orc-pay-btn.active')?.dataset.pay || 'dinheiro';
  }

  // ─── Cliente ──────────────────────────────────────────────────────
  function _onClientSearch(val) {
    clearTimeout(_cliTimeout);
    const el = document.getElementById('orc-cli-results');
    if (!val.trim()) { if (el) el.style.display='none'; return; }
    _cliTimeout = setTimeout(async () => {
      const res = await window.pdv.clientes.buscar(val);
      if (!el) return;
      if (!res.length) {
        // Nenhum cliente encontrado — mostrar opção de cadastro rápido
        el.innerHTML = `
<div style="padding:12px 14px;text-align:center">
  <div style="color:var(--text3);font-size:13px;margin-bottom:10px">Nenhum cliente encontrado para "<strong>${val}</strong>"</div>
  <button class="btn btn-primary btn-sm" onclick="Orcamentos._abrirCadastroCliente('${val.replace(/'/g,"\\'")}')">
    + Cadastrar novo cliente
  </button>
</div>`;
        el.style.display='block';
        return;
      }
      el.innerHTML = res.slice(0,10).map(c=>`
<div onclick="Orcamentos._selecionarCliente('${c.id}','${(c.nome||'').replace(/'/g,"\\'")}','${c.telefone||''}')"
  style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s"
  onmouseenter="this.style.background='var(--bg3)'" onmouseleave="this.style.background=''">
  <div style="font-weight:600;font-size:13px">${c.nome}</div>
  <div style="font-size:11px;color:var(--text3)">${c.telefone||''} ${c.cpf_cnpj?'· '+c.cpf_cnpj:''}</div>
</div>`).join('');
      el.style.display='block';
    }, 200);
  }

  function _abrirCadastroCliente(digitado) {
    // Fecha o dropdown antes de abrir o modal
    const el = document.getElementById('orc-cli-results');
    if (el) el.style.display = 'none';

    // Detecta se o que foi digitado parece telefone ou nome
    const parecePhone = /^[\d\s\-()+]{6,}$/.test(digitado);
    const nomeVal     = parecePhone ? '' : digitado;
    const telVal      = parecePhone ? digitado.replace(/\D/g,'') : '';

    Modal.open(`
<div style="display:flex;flex-direction:column;gap:14px">
  <div>
    <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Nome *</label>
    <input class="input" id="orc-nc-nome" placeholder="Nome completo" value="${nomeVal}"
      onkeydown="if(event.key==='Enter'){document.getElementById('orc-nc-tel').focus()}">
  </div>
  <div>
    <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Celular *</label>
    <input class="input" id="orc-nc-tel" placeholder="(xx) xxxxx-xxxx" value="${telVal}"
      onkeydown="if(event.key==='Enter'){Orcamentos._salvarNovoCliente()}">
  </div>
</div>
<div class="modal-actions" style="margin-top:8px">
  <button class="btn btn-primary" onclick="Orcamentos._salvarNovoCliente()">Salvar cliente</button>
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
</div>`, 'Novo Cliente');

    // Foca no campo correto
    setTimeout(() => {
      const foco = nomeVal ? 'orc-nc-tel' : 'orc-nc-nome';
      document.getElementById(foco)?.focus();
    }, 80);
  }

  async function _salvarNovoCliente() {
    const nome = document.getElementById('orc-nc-nome')?.value?.trim();
    const tel  = document.getElementById('orc-nc-tel')?.value?.trim();
    if (!nome) { Toast.show('Nome é obrigatório', 'error'); document.getElementById('orc-nc-nome')?.focus(); return; }
    if (!tel)  { Toast.show('Celular é obrigatório', 'error'); document.getElementById('orc-nc-tel')?.focus(); return; }

    try {
      const id = await window.pdv.clientes.salvar({ nome, telefone: tel });
      Modal.close();
      _selecionarCliente(id, nome, tel);
      document.getElementById('orc-cli-search').value = '';
      Toast.show(`Cliente ${nome} cadastrado!`, 'success');
    } catch (err) {
      Toast.show('Erro ao salvar cliente: ' + err.message, 'error');
    }
  }

  function _selecionarCliente(id, nome, telefone) {
    _cliente = { id, nome, telefone };
    const box = document.getElementById('orc-cliente-box');
    if (box) box.innerHTML = `
<div style="display:flex;justify-content:space-between;align-items:center">
  <div>
    <div style="font-weight:600;font-size:13px">${nome}</div>
    <div style="font-size:11px;color:var(--text3)">${telefone||'Sem telefone'}</div>
  </div>
  <button onclick="Orcamentos._limparCliente()"
    style="background:none;border:none;cursor:pointer;color:var(--text3);font-size:14px">✕</button>
</div>`;
    document.getElementById('orc-cli-search').value = '';
    document.getElementById('orc-cli-results').style.display = 'none';
  }

  function _limparCliente() {
    _cliente = null;
    const box = document.getElementById('orc-cliente-box');
    if (box) box.innerHTML = `<div style="color:var(--text3);font-size:13px">Sem cliente</div>`;
  }

  // ─── Salvar ──────────────────────────────────────────────────────
  async function salvar() {
    if (!_cart.length) { Toast.show('Adicione pelo menos um produto', 'error'); return; }

    const bruto     = _cart.reduce((s,i) => s + i.quantidade * i.preco_unitario, 0);
    const descItens = _cart.reduce((s,i) => s + (i.desconto||0), 0);
    const subtotal  = bruto - descItens;
    const desconto  = parseFloat(document.getElementById('orc-desconto')?.value) || 0;
    const total     = Math.max(0, subtotal - desconto);
    const condicao  = _getCondicaoTexto();
    const forma     = _getForma();
    const obs       = document.getElementById('orc-obs')?.value?.trim() || null;
    const usuario   = await window.pdv.config.get('auth.usuario') || {};

    const obsCompleta = [obs, condicao !== 'À Vista' ? `Condição: ${condicao}` : null].filter(Boolean).join(' · ') || null;

    const orc = {
      cliente_id:       _cliente?.id || null,
      cliente_nome:     _cliente?.nome || null,
      cliente_telefone: _cliente?.telefone || null,
      vendedor_nome:    usuario.nome || null,
      forma_pagamento:  forma,
      validade_dias:    parseInt(document.getElementById('orc-validade')?.value) || 7,
      subtotal: bruto, desconto, total,
      observacao: obsCompleta,
      itens: _cart.map(i => ({
        produto_id: i.produto_id, produto_nome: i.produto_nome,
        produto_sku: i.produto_sku || null,
        quantidade: i.quantidade, preco_unitario: i.preco_unitario,
        desconto: i.desconto || 0, total: i.total,
      })),
    };

    const btns = document.querySelectorAll('[onclick="Orcamentos.salvar()"]');
    btns.forEach(b => { b.disabled=true; b.textContent='Salvando...'; });

    try {
      if (_orcamentoEditando) {
        await window.pdv.orcamentos.atualizar(_orcamentoEditando.id, orc);
        Toast.show(`Orçamento #${_orcamentoEditando.numero} atualizado!`, 'success');
        _orcamentoEditando = null;
        _modoNovo = false;
        document.getElementById('orc-root').innerHTML = _renderLista();
        load();
      } else {
        const result = await window.pdv.orcamentos.registrar(orc);
        Toast.show(`Orçamento #${result.numero} salvo!`, 'success');
        _modoNovo = false;
        document.getElementById('orc-root').innerHTML = _renderLista();
        load();
        // Oferecer envio por WhatsApp se cliente tiver telefone
        if (_cliente?.telefone) {
          _abrirModalWhatsApp(result.id, _cliente.telefone);
        }
      }
    } catch (err) {
      Toast.show('Erro ao salvar: ' + err.message, 'error');
      btns.forEach(b => { b.disabled=false; b.textContent=_orcamentoEditando?'💾 Salvar Edição':'💾 Salvar Orçamento'; });
    }
  }

  function _abrirModalWhatsApp(id, telefone) {
    WA.abrirModal('Enviar orçamento via WhatsApp', telefone, 'orcamento', id);
  }

  // ─── Detalhes ────────────────────────────────────────────────────
  async function verDetalhes(id) {
    // id pode ser local UUID ou remote_id do Base44
    let isCloudOnly = false;
    let orc = await window.pdv.orcamentos.getById(id);
    if (!orc) {
      // Buscar no cloud (orçamento de outro terminal)
      orc = await window.pdv.orcamentos.getByIdCloud(id);
      isCloudOnly = true;
    }
    if (!orc) { Toast.show('Orçamento não encontrado', 'error'); return; }

    const hoje = new Date();
    const venc = new Date(orc.created_at);
    venc.setDate(venc.getDate() + (orc.validade_dias || 7));
    const expirado = orc.status === 'pendente' && venc < hoje;
    const st = expirado ? 'expirado' : orc.status;
    const badge = { pendente:'<span class="badge badge-yellow">Pendente</span>', aprovado:'<span class="badge badge-green">Aprovado</span>', convertido:'<span class="badge" style="background:var(--accent-bg);color:var(--accent)">Convertido</span>', cancelado:'<span class="badge badge-red">Cancelado</span>', expirado:'<span class="badge" style="background:var(--bg3);color:var(--text3)">Expirado</span>' }[st] || `<span class="badge">${st}</span>`;

    const descItens = (orc.itens||[]).reduce((s,i)=>s+(i.desconto||0), 0);
    const podeAcionar = !isCloudOnly && orc.status !== 'cancelado' && orc.status !== 'convertido';

    Modal.open(`
<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">
  <div style="background:var(--bg3);border-radius:8px;padding:12px">
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Status</div>
    ${badge}
    <div style="font-size:11px;color:var(--text3);margin-top:4px">${_fmtData(orc.created_at)}</div>
  </div>
  <div style="background:var(--bg3);border-radius:8px;padding:12px">
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Cliente</div>
    <div style="font-weight:600">${orc.cliente_nome||'Sem cliente'}</div>
    <div style="font-size:11px;color:var(--text3)">${orc.cliente_telefone||''}</div>
  </div>
  <div style="background:var(--bg3);border-radius:8px;padding:12px">
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Pagamento</div>
    <div style="font-weight:600">${_fmtForma(orc.forma_pagamento)}</div>
    <div style="font-size:11px;color:var(--text3)">Válido até ${_fmtData(venc.toISOString())}</div>
  </div>
  <div style="background:var(--bg3);border-radius:8px;padding:12px">
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Total</div>
    <div class="font-syne" style="font-size:22px;font-weight:700;color:var(--accent)">R$ ${fmtMoney(orc.total)}</div>
    ${(descItens+orc.desconto)>0?`<div style="font-size:11px;color:var(--green)">Economia: R$ ${fmtMoney(descItens+orc.desconto)}</div>`:''}
  </div>
</div>
${orc.observacao?`<div style="background:var(--bg3);border-radius:8px;padding:10px;margin-bottom:14px;font-size:13px;color:var(--text2)">📝 ${orc.observacao}</div>`:''}
<div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:8px">Itens</div>
<table style="width:100%;border-collapse:collapse;margin-bottom:14px">
  <thead><tr style="border-bottom:2px solid var(--border)">
    <th style="text-align:left;padding:8px;font-size:11px;color:var(--text3)">Produto</th>
    <th style="text-align:center;padding:8px;font-size:11px;color:var(--text3)">Qtd</th>
    <th style="text-align:right;padding:8px;font-size:11px;color:var(--text3)">Unit.</th>
    <th style="text-align:right;padding:8px;font-size:11px;color:var(--text3);color:var(--red)">Desc.</th>
    <th style="text-align:right;padding:8px;font-size:11px;color:var(--text3)">Total</th>
  </tr></thead>
  <tbody>
  ${(orc.itens||[]).map(i=>`
  <tr style="border-bottom:1px solid var(--border)">
    <td style="padding:8px">${i.produto_nome}</td>
    <td style="padding:8px;text-align:center">${i.quantidade}</td>
    <td style="padding:8px;text-align:right">R$ ${fmtMoney(i.preco_unitario)}</td>
    <td style="padding:8px;text-align:right;color:var(--red)">${i.desconto>0?`− R$ ${fmtMoney(i.desconto)}`:'—'}</td>
    <td style="padding:8px;text-align:right;font-weight:600;color:var(--accent)">R$ ${fmtMoney(i.total)}</td>
  </tr>`).join('')}
  </tbody>
  <tfoot>
    ${descItens>0?`<tr><td colspan="4" style="padding:6px 8px;text-align:right;color:var(--text3);font-size:12px">Desconto em itens</td><td style="padding:6px 8px;text-align:right;color:var(--red)">− R$ ${fmtMoney(descItens)}</td></tr>`:''}
    ${orc.desconto>0?`<tr><td colspan="4" style="padding:6px 8px;text-align:right;color:var(--text3);font-size:12px">Desconto geral</td><td style="padding:6px 8px;text-align:right;color:var(--red)">− R$ ${fmtMoney(orc.desconto)}</td></tr>`:''}
    <tr><td colspan="4" style="padding:8px;text-align:right;font-weight:700">TOTAL</td>
      <td style="padding:8px;text-align:right;font-weight:700;color:var(--accent);font-family:'Syne',sans-serif;font-size:18px">R$ ${fmtMoney(orc.total)}</td></tr>
  </tfoot>
</table>
<div class="modal-actions" style="gap:8px">
  ${podeAcionar?`
  <button class="btn btn-primary" onclick="Orcamentos.converterEmVenda('${orc.id}');Modal.close()">🛒 Converter em Venda</button>
  <button class="btn btn-ghost" onclick="Orcamentos.abrirEdicao('${orc.id}')">✏️ Editar</button>
  <button class="btn btn-ghost" onclick="Orcamentos.cancelar('${orc.id}');Modal.close()">🗑️ Cancelar</button>`:''}
  <button class="btn btn-ghost" style="color:#25D366"
    onclick="${orc.cliente_telefone ? `WA.abrirModal('Enviar orçamento via WhatsApp','${(orc.cliente_telefone||'').replace(/'/g,"\\'")}','orcamento','${orc.id}')` : `WA.abrirModalCapturaCliente('orcamento','${orc.id}','${(orc.cliente_nome||'').replace(/'/g,"\\'")}')` }">${WA_ICON} WhatsApp</button>
  <button class="btn btn-ghost" onclick="Orcamentos._imprimirOrcamento('${orc.id}')">🖨️ Imprimir</button>
  <button class="btn btn-ghost" onclick="Modal.close()">Fechar</button>
</div>`, `Orçamento #${orc.numero}`);
  }

  // ─── Converter em venda ───────────────────────────────────────────
  async function converterEmVenda(id) {
    const orc = await window.pdv.orcamentos.getById(id);
    if (!orc) { Toast.show('Orçamento não encontrado', 'error'); return; }
    if (orc.status === 'cancelado' || orc.status === 'convertido') { Toast.show('Este orçamento não pode ser convertido', 'error'); return; }
    App.navigate('pdv');
    await PDV.carregarDoOrcamento(orc);
    Toast.show(`Orçamento #${orc.numero} carregado no PDV — finalize a venda normalmente`, 'success');
  }

  async function cancelar(id) {
    const ok = await window.pdv.app.confirm('Cancelar este orçamento?');
    if (!ok) return;
    await window.pdv.orcamentos.cancelar(id);
    Toast.show('Orçamento cancelado', 'success');
    load();
  }

  // ─── Impressão ────────────────────────────────────────────────────
  async function _imprimirOrcamento(id) {
    let orc = await window.pdv.orcamentos.getById(id);
    if (!orc) orc = await window.pdv.orcamentos.getByIdCloud(id);
    if (!orc) { Toast.show('Orçamento não encontrado', 'error'); return; }
    try {
      await window.pdv.print.orcamento(orc);
    } catch (e) { Toast.show('Erro ao imprimir: ' + e.message, 'error'); }
  }

  // ─── Helpers ─────────────────────────────────────────────────────
  function _fmtData(iso) { if (!iso) return '—'; try { return new Date(iso).toLocaleDateString('pt-BR'); } catch { return iso; } }
  function _fmtForma(f) { return {dinheiro:'Dinheiro',pix:'PIX',credito:'Cartão Crédito',debito:'Cartão Débito',boleto:'Boleto',outros:'A Combinar',carteira:'Crédito Loja'}[f]||f||'—'; }

  return {
    render, init, load, onPeriodoChange,
    abrirNovo, abrirEdicao, fecharNovo, salvar,
    verDetalhes, converterEmVenda, cancelar,
    _onSearch, _onSearchKey, _selecionarProduto,
    _qpKey, _qpCalcDesc, _sugerirDescItem, _fecharQtyPanel, _confirmarItem,
    _incQty, _decQty, _setQty, _removeItem, _recalcTotals,
    _sugerirDescGlobal, _selecionarPagamento, _selecionarCondicao,
    _onClientSearch, _selecionarCliente, _limparCliente,
    _imprimirOrcamento,
  };
})();

// ─── Login ────────────────────────────────────────────────────────
const Login = {
  render() {
    return `
<div style="height:100vh;display:flex;align-items:center;justify-content:center;background:var(--bg)">
  <div style="width:360px">
    <div style="text-align:center;margin-bottom:36px">
      <img src="assets/logo.svg" alt="Sistema Vargas"
        style="width:260px;max-width:100%;height:auto;margin:0 auto 12px;display:block">
      <div style="color:var(--text2);font-size:13px;margin-top:4px">Terminal de Vendas · PDV</div>
      <div id="login-version" style="color:var(--text3);font-size:11px;margin-top:4px">v…</div>
    </div>
    <div class="card">
      <div class="form-group">
        <label class="form-label">Operador</label>
        <input class="input" id="l-user" placeholder="login do operador" autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">Senha</label>
        <input class="input" type="password" id="l-pass" placeholder="••••••••"
          onkeydown="if(event.key==='Enter')Login.doLogin()">
      </div>
      <div class="form-group">
        <label class="form-label">ID do Terminal</label>
        <input class="input" id="l-terminal" placeholder="PDV-001"
          value="${''}">
      </div>
      <button class="btn btn-primary" style="width:100%;margin-top:8px" onclick="Login.doLogin()" id="l-btn">
        Entrar
      </button>
      <button class="btn btn-ghost" style="width:100%;margin-top:8px;font-size:12px;opacity:.6" onclick="Login.offlineMode()">
        Modo Offline (sem servidor)
      </button>
      <div id="l-error" style="color:var(--red);font-size:12px;margin-top:10px;text-align:center;display:none"></div>
    </div>
    <div id="login-version-footer" style="text-align:center;margin-top:16px;font-size:11px;color:var(--text3)">
      PDV Vargas · Sistema Vargas
    </div>
  </div>
</div>`;
  },

  async doLogin() {
    const user = document.getElementById('l-user').value.trim();
    const pass = document.getElementById('l-pass').value;
    const terminal = document.getElementById('l-terminal').value.trim() || 'PDV-001';
    const errEl = document.getElementById('l-error');
    const btn = document.getElementById('l-btn');

    if (!user || !pass) { errEl.textContent = 'Informe o operador e a senha'; errEl.style.display = 'block'; return; }

    btn.disabled = true; btn.textContent = 'Autenticando...';
    errEl.style.display = 'none';

    try {
      await window.pdv.config.set('config.app_id', 'vargas');
      await window.pdv.config.set('config.terminal_id', terminal);
      const res = await window.pdv.auth.login(user, pass);
      if (res?.token) {
        await App.showApp();
        App.navigate('pdv');
      } else {
        errEl.textContent = res?.erro || 'Operador ou senha inválidos';
        errEl.style.display = 'block';
      }
    } catch (e) {
      errEl.textContent = 'Erro de conexão com o servidor.';
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = 'Entrar';
    }
  },

  async offlineMode() {
    const terminal = document.getElementById('l-terminal').value.trim() || 'PDV-001';
    await window.pdv.config.set('config.app_id', 'offline');
    await window.pdv.config.set('config.terminal_id', terminal);
    await window.pdv.config.set('auth.token', 'offline_mode');
    // offline: sem permissoes = PDV_PERMS fica null = tudo liberado
    await window.pdv.config.set('auth.usuario', { nome: 'Operador', cargo: 'PDV', permissoes: null });
    await App.showApp();
    App.navigate('pdv');
  }
};

// ─── Produtos ─────────────────────────────────────────────────────
const Produtos = {
  searchTimeout: null,
  sortCol: 'nome',
  sortDir: 'asc',
  cols: { foto:true, nome:true, sku:true, categoria:true, preco:true, custo:false, estoque:true, ncm:false, cfop:false, status:true },
  _data: [],
  _sel: new Set(), // IDs selecionados

  render() {
    return `
<div class="page-header" style="flex-wrap:wrap;gap:8px">
  <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0">
    <div>
      <div class="page-title">Produtos</div>
      <div class="page-sub" id="prod-count">Carregando...</div>
    </div>
    <input class="input" id="prod-search" placeholder="🔍 Buscar produto, SKU, EAN..."
      style="flex:1;max-width:480px" oninput="Produtos.search(this.value)">
  </div>
  <div class="page-actions" style="flex-shrink:0">
    <div style="position:relative;display:inline-block">
      <button class="btn btn-ghost" onclick="Produtos.toggleColMenu()" id="prod-col-btn" title="Colunas visíveis">
        ⚙ Colunas
      </button>
      <div id="prod-col-menu" style="display:none;position:absolute;right:0;top:36px;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:10px 14px;z-index:200;min-width:180px;box-shadow:0 4px 20px rgba(0,0,0,.15)">
        ${[
          ['foto','Foto/Emoji'],['nome','Nome'],['sku','SKU / EAN'],['categoria','Categoria'],
          ['preco','Preço venda'],['custo','Preço custo'],['estoque','Estoque'],
          ['ncm','NCM'],['cfop','CFOP'],['status','Status']
        ].map(([k,l])=>`
        <label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;font-size:13px">
          <input type="checkbox" ${Produtos.cols[k]?'checked':''} onchange="Produtos.toggleCol('${k}',this.checked)"> ${l}
        </label>`).join('')}
      </div>
    </div>
    <button class="btn btn-ghost" onclick="Produtos.resync()" title="Re-sincronizar todos os produtos do Base44">↺ Re-sync</button>
    <button class="btn btn-ghost" id="prod-ia-lote-btn" onclick="Produtos.enriquecerLote()" title="Preencher NCM/CFOP/ICMS com IA para produtos sem dados fiscais" style="color:var(--gold)">🤖 IA em Lote</button>
    <button class="btn btn-primary" onclick="Produtos.openForm()">+ Novo Produto</button>
  </div>
</div>
<!-- Barra de ações para seleção múltipla -->
<div id="prod-sel-bar" style="display:none;background:var(--gold);color:#1a1a0e;padding:10px 20px;display:none;align-items:center;gap:12px;font-size:13px;font-weight:600">
  <span id="prod-sel-count">0 selecionados</span>
  <button class="btn btn-sm" style="background:rgba(0,0,0,.15);color:inherit;border:none" onclick="Produtos.iaLoteSelecionados()">🤖 Preencher fiscal com IA</button>
  <button class="btn btn-sm" style="background:rgba(0,0,0,.15);color:inherit;border:none" onclick="Produtos.desmarcarTodos()">✕ Limpar seleção</button>
  <button class="btn btn-sm" style="background:rgba(0,0,0,.15);color:inherit;border:none;margin-left:auto" onclick="Produtos.selecionarSemNcm()">Selecionar sem NCM</button>
</div>
<div style="flex:1;overflow:auto">
  <div class="table-wrap">
    <table id="prod-table">
      <thead id="prod-thead"></thead>
      <tbody id="prod-tbody"><tr><td colspan="11" style="text-align:center;padding:30px;color:var(--text3)">Carregando...</td></tr></tbody>
    </table>
  </div>
</div>`;
  },

  toggleColMenu() {
    const m = document.getElementById('prod-col-menu');
    if (m) m.style.display = m.style.display === 'none' ? 'block' : 'none';
    const close = (e) => { if (!document.getElementById('prod-col-btn')?.contains(e.target) && !m?.contains(e.target)) { if(m) m.style.display='none'; document.removeEventListener('click',close); } };
    setTimeout(()=>document.addEventListener('click',close),10);
  },

  toggleCol(key, val) {
    this.cols[key] = val;
    this._renderTable();
  },

  _sortBy(col) {
    if (this.sortCol === col) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    else { this.sortCol = col; this.sortDir = 'asc'; }
    this._renderTable();
  },

  _renderHeader() {
    const th = document.getElementById('prod-thead');
    if (!th) return;
    const allChecked = this._data.length > 0 && this._data.every(p => this._sel.has(p.id));
    const cols = [
      { key:'foto',      label:'',           sortable:false },
      { key:'nome',      label:'Produto',    sortable:true  },
      { key:'sku',       label:'SKU / EAN',  sortable:true  },
      { key:'categoria', label:'Categoria',  sortable:true  },
      { key:'preco',     label:'Preço',      sortable:true  },
      { key:'custo',     label:'Custo',      sortable:true  },
      { key:'estoque',   label:'Estoque',    sortable:true  },
      { key:'ncm',       label:'NCM',        sortable:false },
      { key:'cfop',      label:'CFOP',       sortable:false },
      { key:'status',    label:'Status',     sortable:true  },
    ];
    th.innerHTML = `<tr>
      <th style="width:36px;padding:0 8px"><input type="checkbox" id="prod-chk-all" ${allChecked?'checked':''} onchange="Produtos.toggleTodos(this.checked)" title="Selecionar todos"></th>
      ${cols.filter(c=>this.cols[c.key]).map(c=>{
        const arrow = c.sortable ? (this.sortCol===c.key ? (this.sortDir==='asc'?'↑':'↓') : '<span style="opacity:.3">↕</span>') : '';
        const style = c.sortable ? 'cursor:pointer;user-select:none' : '';
        const click = c.sortable ? `onclick="Produtos._sortBy('${c.key}')"` : '';
        return `<th style="${style}" ${click}>${c.label} ${arrow}</th>`;
      }).join('')}
      <th></th></tr>`;
  },

  _sortedData() {
    const col = this.sortCol;
    const dir = this.sortDir === 'asc' ? 1 : -1;
    return [...this._data].sort((a,b) => {
      let va = a[col], vb = b[col];
      if (col==='preco') { va=a.preco_venda; vb=b.preco_venda; }
      if (col==='custo') { va=a.preco_custo; vb=b.preco_custo; }
      if (col==='status') { va=a.ativo?1:0; vb=b.ativo?1:0; }
      if (typeof va==='string') return va.localeCompare(vb||'', 'pt-BR')*dir;
      return ((va||0)-(vb||0))*dir;
    });
  },

  _renderTable() {
    this._renderHeader();
    const tbody = document.getElementById('prod-tbody');
    if (!tbody) return;
    const cols = this.cols;
    const colCount = Object.values(cols).filter(Boolean).length + 1;
    if (!this._data.length) {
      tbody.innerHTML = `<tr><td colspan="${colCount}"><div class="empty-state"><div class="icon">📦</div><h3>Nenhum produto encontrado</h3></div></td></tr>`;
      return;
    }
    tbody.innerHTML = this._sortedData().map(p => {
      const sel = this._sel.has(p.id);
      const cells = [];
      cells.push(`<td style="padding:0 8px;width:36px"><input type="checkbox" ${sel?'checked':''} onchange="Produtos.toggleSel('${p.id}',this.checked)"></td>`);
      if (cols.foto)      cells.push(`<td style="padding:6px 8px">${p.foto_url?`<img src="${p.foto_url}" loading="lazy" onerror="this.style.display='none'" style="width:40px;height:40px;object-fit:cover;border-radius:6px;display:block">`:`<span style="font-size:24px;display:block;text-align:center">${p.emoji||'📦'}</span>`}</td>`);
      if (cols.nome)      cells.push(`<td><span class="td-main">${p.nome}</span>${!p.disponivel_pdv?'<br><span class="badge" style="background:var(--orange);color:#fff;font-size:10px">Fora PDV</span>':''}${!p.ncm?'<span class="badge" style="background:var(--bg3);color:var(--text3);font-size:10px;margin-left:4px">sem NCM</span>':''}</td>`);
      if (cols.sku)       cells.push(`<td class="td-mono">${p.sku||'-'}<br><span style="color:var(--text3);font-size:10px">${p.ean||''}</span></td>`);
      if (cols.categoria) cells.push(`<td>${p.categoria?`<span class="badge badge-blue">${p.categoria}</span>`:'-'}</td>`);
      if (cols.preco)     cells.push(`<td class="td-price">R$ ${fmtMoney(p.preco_venda)}</td>`);
      if (cols.custo)     cells.push(`<td class="td-price" style="color:var(--text2)">R$ ${fmtMoney(p.preco_custo||0)}</td>`);
      if (cols.estoque)   cells.push(`<td><span style="color:${p.estoque===0?'var(--red)':p.estoque<=5?'var(--orange)':'var(--text)'}">${p.estoque??'-'}</span></td>`);
      if (cols.ncm)       cells.push(`<td class="td-mono" style="font-size:12px">${p.ncm||'<span style="color:var(--text3)">—</span>'}</td>`);
      if (cols.cfop)      cells.push(`<td class="td-mono" style="font-size:12px">${p.cfop||'<span style="color:var(--text3)">—</span>'}</td>`);
      if (cols.status)    cells.push(`<td>${p.ativo?'<span class="badge badge-green">Ativo</span>':'<span class="badge badge-gray">Inativo</span>'}</td>`);
      cells.push(`<td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="Produtos.openForm('${p.id}')">Editar</button></td>`);
      return `<tr style="${sel?'background:rgba(var(--gold-rgb,180,140,0),.08)':''}">${cells.join('')}</tr>`;
    }).join('');
  },

  async init() {
    await this.load('');
    const total = await window.pdv.produtos.total();
    const el = document.getElementById('prod-count');
    if (el) el.textContent = `${total.toLocaleString('pt-BR')} produtos cadastrados`;
  },

  async load(query) {
    this._data = (await window.pdv.produtos.buscarGestao(query)) || [];
    this._renderTable();
  },

  search(val) {
    clearTimeout(this.searchTimeout);
    this.searchTimeout = setTimeout(() => this.load(val), 150);
  },

  // ─── Seleção múltipla ────────────────────────────────────────────
  toggleSel(id, checked) {
    if (checked) this._sel.add(id); else this._sel.delete(id);
    this._atualizarBarraSel();
    // atualizar linha sem re-renderizar tudo
    const chkAll = document.getElementById('prod-chk-all');
    if (chkAll) chkAll.checked = this._data.length > 0 && this._data.every(p => this._sel.has(p.id));
  },

  toggleTodos(checked) {
    if (checked) this._data.forEach(p => this._sel.add(p.id));
    else this._sel.clear();
    this._atualizarBarraSel();
    this._renderTable();
  },

  desmarcarTodos() {
    this._sel.clear();
    this._atualizarBarraSel();
    this._renderTable();
  },

  selecionarSemNcm() {
    this._data.filter(p => !p.ncm).forEach(p => this._sel.add(p.id));
    this._atualizarBarraSel();
    this._renderTable();
    Toast.show(`${this._sel.size} produtos sem NCM selecionados`, 'info');
  },

  _atualizarBarraSel() {
    const bar = document.getElementById('prod-sel-bar');
    const count = document.getElementById('prod-sel-count');
    if (!bar) return;
    if (this._sel.size > 0) {
      bar.style.display = 'flex';
      if (count) count.textContent = `${this._sel.size} produto${this._sel.size > 1 ? 's' : ''} selecionado${this._sel.size > 1 ? 's' : ''}`;
    } else {
      bar.style.display = 'none';
    }
  },

  // IA: enriquecer selecionados em lote
  async iaLoteSelecionados() {
    if (!this._sel.size) return;
    const selecionados = this._data.filter(p => this._sel.has(p.id));
    const ok = await window.pdv.app.confirm(`Preencher dados fiscais com IA para ${selecionados.length} produto(s) selecionado(s)?`);
    if (!ok) return;

    const bar = document.getElementById('prod-sel-bar');
    const countEl = document.getElementById('prod-sel-count');
    const GRUPO = 10;
    let ok_count = 0, err_count = 0;

    for (let i = 0; i < selecionados.length; i += GRUPO) {
      const grupo = selecionados.slice(i, i + GRUPO).map(p => ({ id: p.id, nome: p.nome, categoria: p.categoria, unidade: p.unidade }));
      if (countEl) countEl.textContent = `🤖 Processando ${Math.min(i + GRUPO, selecionados.length)}/${selecionados.length}...`;
      try {
        const resultados = await window.pdv.ia.lote(grupo);
        for (const r of resultados) {
          if (!r.id || !r.ncm) continue;
          await window.pdv.produtos.atualizar(r.id, {
            ncm: r.ncm, cfop: r.cfop, icms_cst: r.icms_cst,
            icms_origem: r.icms_origem || 0, pis_cst: r.pis_cst, cofins_cst: r.cofins_cst,
          });
          ok_count++;
        }
      } catch(e) {
        err_count += grupo.length;
        console.error('[IA lote]', e.message);
      }
    }

    Toast.show(`IA concluída: ${ok_count} produtos atualizados${err_count ? ` · ${err_count} erros` : ''}`, ok_count ? 'success' : 'error');
    this._sel.clear();
    this._atualizarBarraSel();
    await this.load(document.getElementById('prod-search')?.value || '');
  },

  async resync() {
    const btn = document.querySelector('[onclick="Produtos.resync()"]');
    if (btn) { btn.disabled = true; btn.textContent = '↺ Sincronizando...'; }
    try {
      await window.pdv.sync.fullProdutos();
      Toast.show('Produtos re-sincronizados com sucesso!', 'success');
      await this.load(document.getElementById('prod-search')?.value || '');
    } catch(e) {
      Toast.show('Erro ao re-sincronizar: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '↺ Re-sync'; }
    }
  },

  // IA: preencher campos fiscais no formulário aberto
  async iaFiscalForm() {
    const nome = document.getElementById('pf-nome')?.value?.trim();
    const cat  = document.getElementById('pf-cat')?.value?.trim();
    const un   = document.getElementById('pf-un')?.value?.trim();
    if (!nome) { Toast.show('Informe o nome do produto primeiro', 'error'); return; }

    const btn = document.getElementById('pf-ia-btn');
    const status = document.getElementById('pf-ia-status');
    if (btn) { btn.disabled = true; btn.textContent = '🤖 Consultando IA...'; }
    if (status) { status.style.display = 'block'; status.textContent = 'Aguardando resposta da IA...'; }

    try {
      const r = await window.pdv.ia.fiscal(nome, cat, un);
      const g = (id) => document.getElementById(id);
      if (r.ncm)        { const el = g('pf-ncm');        if(el) el.value = r.ncm; }
      if (r.cfop)       { const el = g('pf-cfop');       if(el) el.value = r.cfop; }
      if (r.icms_cst)   { const el = g('pf-icms-cst');   if(el) el.value = r.icms_cst; }
      if (r.icms_origem !== undefined) { const el = g('pf-icms-origem'); if(el) el.value = r.icms_origem; }
      if (r.pis_cst)    { const el = g('pf-pis-cst');    if(el) el.value = r.pis_cst; }
      if (r.cofins_cst) { const el = g('pf-cofins-cst'); if(el) el.value = r.cofins_cst; }
      if (status && r.justificativa_ncm) {
        status.textContent = `NCM ${r.ncm}: ${r.justificativa_ncm}`;
        status.style.color = 'var(--green)';
      }
    } catch(e) {
      if (status) { status.textContent = '⚠ ' + e.message; status.style.color = 'var(--red)'; }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🤖 Preencher com IA'; }
    }
  },

  // IA: enriquecer produto individual direto da lista (sem abrir form)
  async enriquecerIA(id, nome, categoria, unidade) {
    try {
      Toast.show(`🤖 Consultando IA para "${nome}"...`, 'info');
      const r = await window.pdv.ia.fiscal(nome, categoria, unidade);
      await window.pdv.produtos.atualizar(id, {
        ncm: r.ncm, cfop: r.cfop, icms_cst: r.icms_cst,
        icms_origem: r.icms_origem, pis_cst: r.pis_cst, cofins_cst: r.cofins_cst,
      });
      Toast.show(`NCM ${r.ncm} aplicado em "${nome}"`, 'success');
      await this.load(document.getElementById('prod-search')?.value || '');
    } catch(e) {
      Toast.show('Erro IA: ' + e.message, 'error');
    }
  },

  // IA: enriquecer em lote todos os produtos sem NCM
  async enriquecerLote() {
    const semNcm = this._data.filter(p => !p.ncm);
    if (!semNcm.length) { Toast.show('Todos os produtos já têm NCM cadastrado', 'success'); return; }

    const ok = await window.pdv.app.confirm(`Enriquecer ${semNcm.length} produto(s) sem NCM com IA? Isso pode levar alguns minutos.`);
    if (!ok) return;

    const btn = document.getElementById('prod-ia-lote-btn');
    if (btn) { btn.disabled = true; btn.textContent = '🤖 Processando...'; }

    // Processar em grupos de 20 para não ultrapassar context
    const GRUPO = 10;
    let ok_count = 0, err_count = 0;

    for (let i = 0; i < semNcm.length; i += GRUPO) {
      const grupo = semNcm.slice(i, i + GRUPO).map(p => ({ id: p.id, nome: p.nome, categoria: p.categoria, unidade: p.unidade }));
      if (btn) btn.textContent = `🤖 ${i}/${semNcm.length}...`;
      try {
        const resultados = await window.pdv.ia.lote(grupo);
        for (const r of resultados) {
          if (!r.id || !r.ncm) continue;
          await window.pdv.produtos.atualizar(r.id, {
            ncm: r.ncm, cfop: r.cfop, icms_cst: r.icms_cst,
            icms_origem: r.icms_origem, pis_cst: r.pis_cst, cofins_cst: r.cofins_cst,
          });
          ok_count++;
        }
      } catch(e) { err_count += grupo.length; }
    }

    Toast.show(`IA concluída: ${ok_count} produtos enriquecidos${err_count ? `, ${err_count} erros` : ''}`, ok_count ? 'success' : 'error');
    if (btn) { btn.disabled = false; btn.textContent = '🤖 IA em Lote'; }
    await this.load(document.getElementById('prod-search')?.value || '');
  },

  async openForm(id = null) {
    let p = { emoji: '📦', nome: '', sku: '', ean: '', preco_venda: '', preco_custo: '', unidade: 'UN', categoria: '', marca: '', ativo: true, disponivel_pdv: true };
    if (id) { p = await window.pdv.produtos.getById(id) || p; }

    Modal.open(`
<div class="form-row cols-2">
  <div class="form-group">
    <label class="form-label">Emoji</label>
    <input class="input" id="pf-emoji" value="${p.emoji || '📦'}" style="text-align:center;font-size:22px">
  </div>
  <div class="form-group">
    <label class="form-label">Unidade</label>
    <input class="input" id="pf-un" value="${p.unidade || 'UN'}" placeholder="UN, KG, LT...">
  </div>
</div>
<div class="form-group">
  <label class="form-label">Nome *</label>
  <input class="input" id="pf-nome" value="${p.nome || ''}" placeholder="Nome do produto">
</div>
<div class="form-row cols-2">
  <div class="form-group">
    <label class="form-label">SKU</label>
    <input class="input" id="pf-sku" value="${p.sku || ''}">
  </div>
  <div class="form-group">
    <label class="form-label">EAN / Código de barras</label>
    <input class="input" id="pf-ean" value="${p.ean || ''}">
  </div>
</div>
<div class="form-row cols-2">
  <div class="form-group">
    <label class="form-label">Preço de Venda (R$) *</label>
    <input class="input" id="pf-preco" type="number" step="0.01" value="${p.preco_venda || ''}">
  </div>
  <div class="form-group">
    <label class="form-label">Preço de Custo (R$)</label>
    <input class="input" id="pf-custo" type="number" step="0.01" value="${p.preco_custo || ''}">
  </div>
</div>
<div class="form-row cols-2">
  <div class="form-group">
    <label class="form-label">Categoria</label>
    <input class="input" id="pf-cat" value="${p.categoria || ''}">
  </div>
  <div class="form-group">
    <label class="form-label">Marca</label>
    <input class="input" id="pf-marca" value="${p.marca || ''}">
  </div>
</div>

<!-- Visibilidade -->
<div style="margin:10px 0 6px;padding-top:12px;border-top:1px solid var(--border)">
  <label style="display:flex;align-items:center;gap:10px;cursor:pointer">
    <input type="checkbox" id="pf-disponivel" ${p.disponivel_pdv!==false?'checked':''}>
    <span style="font-size:13px">Disponível no PDV (visível na busca de vendas)</span>
  </label>
</div>

<!-- Dados Fiscais -->
<div style="margin:14px 0 8px;padding-top:14px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
  <span style="font-size:11px;font-weight:700;color:var(--text3);letter-spacing:.8px">DADOS FISCAIS (NFC-e / NF-e)</span>
  <button class="btn btn-ghost btn-sm" id="pf-ia-btn" onclick="Produtos.iaFiscalForm()" style="font-size:12px;color:var(--gold)">
    🤖 Preencher com IA
  </button>
</div>
<div id="pf-ia-status" style="display:none;font-size:12px;color:var(--text2);margin-bottom:8px;padding:8px;background:var(--bg2);border-radius:6px"></div>
<div class="form-row cols-2">
  <div class="form-group">
    <label class="form-label">NCM</label>
    <input class="input" id="pf-ncm" value="${p.ncm || ''}" placeholder="0000.00.00" maxlength="10">
  </div>
  <div class="form-group">
    <label class="form-label">CFOP</label>
    <input class="input" id="pf-cfop" value="${p.cfop || '5102'}" placeholder="5102">
  </div>
</div>
<div class="form-row cols-2">
  <div class="form-group">
    <label class="form-label">CSOSN / CST (ICMS)</label>
    <select class="input" id="pf-icms-cst">
      <option value="400" ${(p.icms_cst||'400')==='400'?'selected':''}>400 — Tributado pelo Simples, sem crédito</option>
      <option value="102" ${p.icms_cst==='102'?'selected':''}>102 — Tributado pelo Simples, sem permissão de crédito</option>
      <option value="103" ${p.icms_cst==='103'?'selected':''}>103 — Isenção p/ faixa de receita</option>
      <option value="300" ${p.icms_cst==='300'?'selected':''}>300 — Imune</option>
      <option value="500" ${p.icms_cst==='500'?'selected':''}>500 — ICMS cobrado por substituição tributária</option>
      <option value="900" ${p.icms_cst==='900'?'selected':''}>900 — Outros</option>
      <option value="00"  ${p.icms_cst==='00' ?'selected':''}>00 — Tributada integralmente (Lucro Real/Presumido)</option>
      <option value="40"  ${p.icms_cst==='40' ?'selected':''}>40 — Isenta (Lucro Real/Presumido)</option>
      <option value="60"  ${p.icms_cst==='60' ?'selected':''}>60 — ICMS cobrado por ST</option>
    </select>
  </div>
  <div class="form-group">
    <label class="form-label">Origem (ICMS)</label>
    <select class="input" id="pf-icms-origem">
      <option value="0" ${(!p.icms_origem||p.icms_origem==0)?'selected':''}>0 — Nacional</option>
      <option value="1" ${p.icms_origem==1?'selected':''}>1 — Estrangeira (importação direta)</option>
      <option value="2" ${p.icms_origem==2?'selected':''}>2 — Estrangeira (adq. mercado interno)</option>
    </select>
  </div>
</div>
<div class="form-row cols-2">
  <div class="form-group">
    <label class="form-label">CST PIS</label>
    <select class="input" id="pf-pis-cst">
      <option value="07" ${(p.pis_cst||'07')==='07'?'selected':''}>07 — Operação isenta (Simples)</option>
      <option value="01" ${p.pis_cst==='01'?'selected':''}>01 — Operação tributável 0,65%</option>
      <option value="02" ${p.pis_cst==='02'?'selected':''}>02 — Operação tributável alíq. diferenciada</option>
      <option value="06" ${p.pis_cst==='06'?'selected':''}>06 — Operação tributável a alíq. zero</option>
      <option value="49" ${p.pis_cst==='49'?'selected':''}>49 — Outras operações de saída</option>
    </select>
  </div>
  <div class="form-group">
    <label class="form-label">CST COFINS</label>
    <select class="input" id="pf-cofins-cst">
      <option value="07" ${(p.cofins_cst||'07')==='07'?'selected':''}>07 — Operação isenta (Simples)</option>
      <option value="01" ${p.cofins_cst==='01'?'selected':''}>01 — Operação tributável 3%</option>
      <option value="02" ${p.cofins_cst==='02'?'selected':''}>02 — Operação tributável alíq. diferenciada</option>
      <option value="06" ${p.cofins_cst==='06'?'selected':''}>06 — Operação tributável a alíq. zero</option>
      <option value="49" ${p.cofins_cst==='49'?'selected':''}>49 — Outras operações de saída</option>
    </select>
  </div>
</div>

<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
  <button class="btn btn-primary" onclick="Produtos.salvar('${id || ''}')">Salvar</button>
</div>`, id ? 'Editar Produto' : 'Novo Produto');
  },

  async salvar(id) {
    const g = (i) => document.getElementById(i);
    const dados = {
      emoji: g('pf-emoji').value,
      nome: g('pf-nome').value.trim(),
      sku: g('pf-sku').value.trim(),
      ean: g('pf-ean').value.trim(),
      preco_venda: parseFloat(g('pf-preco').value),
      preco_custo: parseFloat(g('pf-custo').value) || 0,
      unidade: g('pf-un').value || 'UN',
      categoria: g('pf-cat').value,
      marca: g('pf-marca').value,
      ativo: true,
      ncm: g('pf-ncm').value.trim(),
      cfop: g('pf-cfop').value.trim() || '5102',
      icms_cst: g('pf-icms-cst').value || '400',
      icms_origem: parseInt(g('pf-icms-origem').value) || 0,
      pis_cst: g('pf-pis-cst').value || '07',
      cofins_cst: g('pf-cofins-cst').value || '07',
      disponivel_pdv: g('pf-disponivel').checked ? 1 : 0,
    };
    if (!dados.nome || !dados.preco_venda) { Toast.show('Nome e preço são obrigatórios', 'error'); return; }
    if (id) { await window.pdv.produtos.atualizar(id, dados); Toast.show('Produto atualizado!', 'success'); }
    else { await window.pdv.produtos.salvar(dados); Toast.show('Produto criado!', 'success'); }
    Modal.close();
    await this.load(document.getElementById('prod-search')?.value || '');
  }
};

// ─── Clientes ─────────────────────────────────────────────────────
const Clientes = {
  render() {
    return `
<div class="page-header">
  <div><div class="page-title">Clientes</div></div>
  <div class="page-actions">
    <input class="input" id="cli-search" placeholder="🔍 Buscar..." style="width:220px" oninput="Clientes.load(this.value)">
    <button class="btn btn-ghost" id="btn-sync-clientes" onclick="Clientes.syncForcar()" title="Buscar todos os clientes do sistema">↻ Sincronizar</button>
    <button class="btn btn-primary" onclick="Clientes.openForm()">+ Novo Cliente</button>
  </div>
</div>
<div style="flex:1;overflow:auto">
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Nome</th><th>Telefone</th><th>Cidade</th><th>Ativo</th>
        <th>Limite</th><th>Em Aberto</th><th>Disponível</th><th></th>
      </tr></thead>
      <tbody id="cli-tbody"><tr><td colspan="8" style="text-align:center;padding:30px;color:var(--text3)">Carregando...</td></tr></tbody>
    </table>
  </div>
</div>`;
  },

  async init() { await this.load(''); },

  async syncForcar() {
    const btn = document.getElementById('btn-sync-clientes');
    if (btn) { btn.disabled = true; btn.textContent = '↻ Sincronizando...'; }
    try {
      const res = await window.pdv.clientes.syncForcar();
      if (res?.erro) { Toast.show('Erro: ' + res.erro, 'error'); }
      else { Toast.show(`${res?.total || 0} clientes sincronizados`, 'success'); }
      await this.load(document.getElementById('cli-search')?.value || '');
    } catch(e) {
      Toast.show('Erro ao sincronizar: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '↻ Sincronizar'; }
    }
  },

  async load(q) {
    const lista = await window.pdv.clientes.buscar(q);
    const tbody = document.getElementById('cli-tbody');
    if (!tbody) return;
    if (!lista.length) {
      tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state"><div class="icon">👤</div><h3>Nenhum cliente</h3></div></td></tr>';
      return;
    }
    // Carregar resumo de créditos para cada cliente
    const rows = await Promise.all(lista.map(async c => {
      const remoteId = c.remote_id || c.id;
      const resumo = await window.pdv.creditos.resumo(remoteId);
      const emAberto = resumo?.total_saldo || 0;
      const disponivel = Math.max(0, (c.limite_credito || 0) - emAberto);
      return { c, emAberto, disponivel };
    }));
    tbody.innerHTML = rows.map(({ c, emAberto, disponivel }) => `
      <tr>
        <td class="td-main">👤 ${c.nome}<br><span style="font-size:11px;color:var(--text3)">${c.cpf_cnpj || ''}</span></td>
        <td>${c.telefone || '-'}</td>
        <td style="font-size:12px;color:var(--text2)">${c.email || '-'}</td>
        <td>${c.ativo !== false ? '<span class="badge badge-green">Sim</span>' : '<span class="badge badge-gray">Não</span>'}</td>
        <td class="td-price">R$ ${fmtMoney(c.limite_credito)}</td>
        <td><span style="color:${emAberto > 0 ? 'var(--red)' : 'var(--text2)'}">R$ ${fmtMoney(emAberto)}</span></td>
        <td><span style="color:${disponivel > 0 ? 'var(--green)' : disponivel === 0 && c.limite_credito > 0 ? 'var(--red)' : 'var(--text2)'}">R$ ${fmtMoney(disponivel)}</span></td>
        <td>
          <div class="flex gap-8">
            ${emAberto > 0 && podePermissao('receber_contas_clientes') ? `<button class="btn btn-primary btn-sm" onclick="Clientes.verConta('${c.remote_id || c.id}','${c.nome}','${c.id}')">Receber</button>` : ''}
            <button class="btn btn-ghost btn-sm" onclick="Clientes.verConta('${c.remote_id || c.id}','${c.nome}','${c.id}')">Ver Conta</button>
          </div>
        </td>
      </tr>`).join('');
  },

  async openForm() {
    Modal.open(`
<div class="form-group"><label class="form-label">Nome *</label><input class="input" id="cf-nome" placeholder="Nome completo"></div>
<div class="form-row cols-2">
  <div class="form-group"><label class="form-label">CPF / CNPJ</label><input class="input" id="cf-cpf"></div>
  <div class="form-group"><label class="form-label">Telefone</label><input class="input" id="cf-tel"></div>
</div>
<div class="form-group"><label class="form-label">Email</label><input class="input" id="cf-email" type="email"></div>
<div class="form-row cols-2">
  <div class="form-group"><label class="form-label">Limite de Crédito (R$)</label><input class="input" id="cf-limite" type="number" step="0.01" value="0"></div>
  <div class="form-group"><label class="form-label">Saldo Inicial (R$)</label><input class="input" id="cf-saldo" type="number" step="0.01" value="0"></div>
</div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
  <button class="btn btn-primary" onclick="Clientes.salvar()">Salvar</button>
</div>`, 'Novo Cliente');
  },

  async salvar() {
    const dados = {
      nome: document.getElementById('cf-nome').value.trim(),
      cpf_cnpj: document.getElementById('cf-cpf').value.trim(),
      telefone: document.getElementById('cf-tel').value.trim(),
      email: document.getElementById('cf-email').value.trim(),
      limite_credito: parseFloat(document.getElementById('cf-limite').value) || 0,
      saldo_credito: parseFloat(document.getElementById('cf-saldo').value) || 0,
    };
    if (!dados.nome) { Toast.show('Nome é obrigatório', 'error'); return; }
    await window.pdv.clientes.salvar(dados);
    Toast.show('Cliente salvo!', 'success');
    Modal.close();
    await this.load('');
  },

  async verConta(remoteId, nome, localId) {
    const creditos = await window.pdv.creditos.getAbertos(remoteId);
    const cliente = await window.pdv.clientes.getById(localId);
    const totalAberto = creditos.reduce((s, c) => s + (c.saldo_atual || 0), 0);
    const disponivel = Math.max(0, (cliente?.limite_credito || 0) - totalAberto);

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
  ${cr.observacao ? `<div style="font-size:11px;color:var(--text2);margin-bottom:8px">${cr.observacao}</div>` : ''}
  ${podePermissao('receber_contas_clientes') ? `<div class="flex gap-8" style="margin-top:8px">
    <input class="input" type="number" step="0.01" min="0.01" max="${cr.saldo_atual}"
      id="rec-val-${cr.id}" value="${fmtMoney(cr.saldo_atual).replace(',','.')}"
      style="flex:1;padding:6px 10px;font-size:13px" placeholder="Valor a receber">
    <button class="btn btn-primary btn-sm" onclick="Clientes._receberItem('${cr.id}',${cr.saldo_atual},'${remoteId}','${nome}','${localId}')">
      Receber
    </button>
  </div>` : ''}
</div>`).join('');

    Modal.open(`
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:16px">
  <div style="background:var(--bg3);border-radius:8px;padding:12px;text-align:center">
    <div style="font-size:11px;color:var(--text3);margin-bottom:4px">LIMITE</div>
    <div class="font-syne" style="font-size:18px">R$ ${fmtMoney(cliente?.limite_credito || 0)}</div>
  </div>
  <div style="background:var(--bg3);border-radius:8px;padding:12px;text-align:center">
    <div style="font-size:11px;color:var(--text3);margin-bottom:4px">EM ABERTO</div>
    <div class="font-syne" style="font-size:18px;color:var(--red)">R$ ${fmtMoney(totalAberto)}</div>
  </div>
  <div style="background:var(--bg3);border-radius:8px;padding:12px;text-align:center">
    <div style="font-size:11px;color:var(--text3);margin-bottom:4px">DISPONÍVEL</div>
    <div class="font-syne" style="font-size:18px;color:var(--green)">R$ ${fmtMoney(disponivel)}</div>
  </div>
</div>
<div style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);margin-bottom:10px">Contas em Aberto</div>
<div id="conta-lista">${renderLista(creditos)}</div>
<div class="modal-actions"><button class="btn btn-ghost" onclick="Modal.close()">Fechar</button></div>
`, `Conta — ${nome}`);
  },

  async _receberItem(creditoId, saldoAtual, remoteClienteId, nome, localId) {
    const input = document.getElementById(`rec-val-${creditoId}`);
    const valorPago = parseFloat(input?.value) || 0;
    if (valorPago <= 0) { Toast.show('Informe um valor válido', 'error'); return; }
    if (valorPago > saldoAtual) { Toast.show('Valor maior que o saldo', 'error'); return; }
    const obs = `Recebimento PDV ${new Date().toLocaleDateString('pt-BR')}`;
    await window.pdv.creditos.receber(creditoId, valorPago, saldoAtual, obs);
    Toast.show(`R$ ${fmtMoney(valorPago)} recebido com sucesso!`, 'success');
    Modal.close();
    await this.verConta(remoteClienteId, nome, localId);
  }
};

// ─── WhatsApp ─────────────────────────────────────────────────────
const WA = {
  // Envia via pdvProxy → Z-API server-side
  async enviar(tipo, id, telefone, dadosExtras) {
    try {
      await window.pdv.whatsapp.enviar(tipo, id, telefone || null, dadosExtras || null);
      Toast.show('WhatsApp enviado com sucesso!', 'success');
      Modal.close();
    } catch (e) {
      Toast.show('Erro ao enviar WhatsApp: ' + (e.message || e), 'error');
    }
  },

  // Dados extras (venda nuvem) passados entre modais
  _dadosExtras: null,
  _vendas: {},

  // Modal de confirmação com campo de telefone editável
  abrirModal(titulo, telefoneInicial, tipo, id, dadosExtras) {
    WA._dadosExtras = dadosExtras || null;
    Modal.open(`
<div style="display:flex;flex-direction:column;gap:14px">
  <p style="color:var(--text2);font-size:13px;margin:0">
    ${tipo === 'venda' ? 'O cupom será enviado como PDF via WhatsApp Z-API.' : 'O servidor irá montar a mensagem e enviar via WhatsApp Z-API.'}
  </p>
  <div>
    <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">
      Número WhatsApp do cliente
    </label>
    <input class="input" id="wa-telefone" placeholder="(xx) xxxxx-xxxx" value="${telefoneInicial || ''}"
      onkeydown="if(event.key==='Enter')document.getElementById('wa-btn-enviar').click()">
  </div>
</div>
<div class="modal-actions" style="margin-top:8px">
  <button id="wa-btn-enviar" class="btn btn-primary" style="background:#25D366;border-color:#25D366"
    onclick="WA.enviar('${tipo}','${id}',document.getElementById('wa-telefone').value,WA._dadosExtras)">
    📱 Enviar WhatsApp
  </button>
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
</div>`, titulo);
    setTimeout(() => {
      const inp = document.getElementById('wa-telefone');
      inp?.focus(); inp?.select();
    }, 80);
  },

  // Modal para capturar telefone quando não há cadastro
  abrirModalCapturaCliente(tipo, id, nomeAtual, dadosExtras) {
    WA._dadosExtras = dadosExtras || null;
    Modal.open(`
<div style="display:flex;flex-direction:column;gap:12px">
  <p style="color:var(--text2);font-size:13px;margin:0">
    Informe o celular do cliente para enviar via WhatsApp.
  </p>
  <div>
    <label style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--text3);display:block;margin-bottom:4px">Celular / WhatsApp</label>
    <input class="input" id="wa-cc-tel" placeholder="(xx) xxxxx-xxxx"
      onkeydown="if(event.key==='Enter')WA._salvarTelefoneEEnviar('${tipo}','${id}')">
  </div>
</div>
<div class="modal-actions" style="margin-top:8px">
  <button class="btn btn-primary" style="background:#25D366;border-color:#25D366"
    onclick="WA._salvarTelefoneEEnviar('${tipo}','${id}')">
    📱 Enviar WhatsApp
  </button>
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
</div>`, 'Enviar por WhatsApp');
    setTimeout(() => document.getElementById('wa-cc-tel')?.focus(), 80);
  },

  async _salvarTelefoneEEnviar(tipo, id) {
    const tel = document.getElementById('wa-cc-tel')?.value?.trim();
    if (!tel) { Toast.show('Celular é obrigatório', 'error'); return; }
    Modal.close();
    WA.abrirModal(
      tipo === 'venda' ? 'Enviar cupom via WhatsApp' : 'Enviar orçamento via WhatsApp',
      tel, tipo, id, WA._dadosExtras
    );
  },
};

// ─── Vendas ───────────────────────────────────────────────────────
const Vendas = {
  _todoTerminais: false,
  _sortCol: 'data',
  _sortDir: 'desc',
  _sel: new Set(),
  _lista: [],

  render() {
    const podeVerTodos = podePermissao('ver_vendas_todos_terminais');
    return `
<div class="page-header">
  <div><div class="page-title">Vendas</div></div>
  <div class="page-actions" style="display:flex;gap:8px;align-items:center">
    ${podeVerTodos ? `
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text2);cursor:pointer;white-space:nowrap">
      <input type="checkbox" id="venda-todos-terminais" onchange="Vendas.toggleTodos(this.checked)" style="cursor:pointer">
      Todos os terminais
    </label>` : ''}
    <input class="input" id="venda-busca-produto" type="text" placeholder="🔍 Buscar por produto..." style="min-width:200px" oninput="Vendas.load()">
    <input class="input" id="venda-data" type="date" value="${new Date().toISOString().split('T')[0]}" onchange="Vendas.load()">
  </div>
</div>
<div style="padding:16px 20px;border-bottom:1px solid var(--border);display:grid;grid-template-columns:repeat(4,1fr);gap:12px" id="vendas-totais"></div>
<div id="vendas-sel-bar" style="display:none;padding:10px 20px;background:var(--accent);color:#fff;display:none;align-items:center;gap:12px;font-size:13px">
  <span id="vendas-sel-count"></span>
  <button class="btn btn-sm" style="background:rgba(255,255,255,.2);color:#fff;border:none" onclick="Vendas.nfceLote()">🧾 Emitir NFC-e Selecionadas</button>
  <button class="btn btn-sm" style="background:rgba(255,255,255,.1);color:#fff;border:none;margin-left:auto" onclick="Vendas.desmarcarTodas()">✕ Desmarcar</button>
</div>
<div style="flex:1;overflow:auto">
  <div class="table-wrap">
    <table id="vendas-table">
      <thead id="vendas-thead"></thead>
      <tbody id="vendas-tbody"></tbody>
    </table>
  </div>
</div>`;
  },

  async init() { this._todoTerminais = false; this._sel = new Set(); this._lista = []; await this.load(); },

  toggleTodos(val) { this._todoTerminais = val; this._sel = new Set(); this.load(); },

  _thSort(col, label) {
    const ativo = this._sortCol === col;
    const icone = ativo ? (this._sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th style="cursor:pointer;white-space:nowrap;user-select:none" onclick="Vendas.ordenar('${col}')">${label}${icone}</th>`;
  },

  ordenar(col) {
    if (this._sortCol === col) {
      this._sortDir = this._sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      this._sortCol = col;
      this._sortDir = col === 'total' ? 'desc' : 'asc';
    }
    this._renderTabela();
  },

  _sortLista(lista) {
    const col = this._sortCol;
    const dir = this._sortDir === 'asc' ? 1 : -1;
    return [...lista].sort((a, b) => {
      let va, vb;
      if (col === 'data') {
        va = a.created_at || a.created_date || '';
        vb = b.created_at || b.created_date || '';
      } else if (col === 'total') {
        va = a.total || 0; vb = b.total || 0;
      } else if (col === 'cliente') {
        va = (a.cliente_nome || '').toLowerCase();
        vb = (b.cliente_nome || '').toLowerCase();
      } else if (col === 'numero') {
        va = a.numero || 0; vb = b.numero || 0;
      } else if (col === 'status') {
        va = a.status || ''; vb = b.status || '';
      } else if (col === 'pagamento') {
        va = a.forma_pagamento || ''; vb = b.forma_pagamento || '';
      } else {
        va = ''; vb = '';
      }
      if (va < vb) return -dir;
      if (va > vb) return dir;
      return 0;
    });
  },

  _atualizarBarraSel() {
    const bar = document.getElementById('vendas-sel-bar');
    const cnt = document.getElementById('vendas-sel-count');
    if (!bar) return;
    if (this._sel.size > 0) {
      bar.style.display = 'flex';
      cnt.textContent = `${this._sel.size} venda(s) selecionada(s)`;
    } else {
      bar.style.display = 'none';
    }
  },

  toggleSel(id, el) {
    if (el.checked) this._sel.add(id);
    else this._sel.delete(id);
    this._atualizarBarraSel();
  },

  toggleTodasSel(el) {
    const lista = this._lista.filter(v => v.status !== 'cancelada');
    if (el.checked) lista.forEach(v => this._sel.add(v.id || v.remote_id));
    else this._sel.clear();
    this._atualizarBarraSel();
    this._renderTabela();
  },

  desmarcarTodas() {
    this._sel.clear();
    this._atualizarBarraSel();
    this._renderTabela();
  },

  async load() {
    const data = document.getElementById('venda-data')?.value || new Date().toISOString().split('T')[0];
    const tbody = document.getElementById('vendas-tbody');
    if (!tbody) return;
    this._sel = new Set();
    this._atualizarBarraSel();

    if (this._todoTerminais) {
      tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--text3)">Carregando...</td></tr>';
      try {
        const lista = await window.pdv.vendas.listarCloud(data);
        this._lista = lista;

        const tt = document.getElementById('vendas-totais');
        if (tt && podePermissao('ver_total_vendas_dia')) {
          const ativos  = lista.filter(v => v.status !== 'cancelada');
          const totalValor = ativos.reduce((s, v) => s + (v.total || 0), 0);
          const pix        = ativos.filter(v => v.forma_pagamento === 'pix').reduce((s, v) => s + (v.total || 0), 0);
          const dinheiro   = ativos.filter(v => v.forma_pagamento === 'dinheiro').reduce((s, v) => s + (v.total || 0), 0);
          const cartao     = ativos.filter(v => ['credito','debito','cartao_credito','cartao_debito'].includes(v.forma_pagamento)).reduce((s, v) => s + (v.total || 0), 0);
          tt.innerHTML = `
            <div class="card"><div class="card-label">Total Vendas</div><div class="card-value">R$ ${fmtMoney(totalValor)}</div></div>
            <div class="card"><div class="card-label">Transações</div><div class="card-value">${ativos.length}</div></div>
            <div class="card"><div class="card-label">PIX + Dinheiro</div><div class="card-value">R$ ${fmtMoney(pix + dinheiro)}</div></div>
            <div class="card"><div class="card-label">Cartão</div><div class="card-value">R$ ${fmtMoney(cartao)}</div></div>`;
        } else if (tt) { tt.innerHTML = ''; }

        this._renderTabela();
      } catch(e) {
        tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--red)">Erro ao carregar: ${e.message}</td></tr>`;
      }
    } else {
      const buscaProduto = document.getElementById('venda-busca-produto')?.value?.trim() || '';
      const lista  = await window.pdv.vendas.listar({ data_inicio: data, data_fim: data, ...(buscaProduto ? { produto: buscaProduto } : {}) });
      const totais = await window.pdv.vendas.totaisHoje();
      this._lista = lista;

      const tt = document.getElementById('vendas-totais');
      if (tt) tt.innerHTML = podePermissao('ver_total_vendas_dia') ? `
        <div class="card"><div class="card-label">Total Vendas</div><div class="card-value">R$ ${fmtMoney(totais?.total_valor)}</div></div>
        <div class="card"><div class="card-label">Transações</div><div class="card-value">${totais?.total_vendas || 0}</div></div>
        <div class="card"><div class="card-label">PIX + Dinheiro</div><div class="card-value">R$ ${fmtMoney((totais?.pix||0)+(totais?.dinheiro||0))}</div></div>
        <div class="card"><div class="card-label">Cartão</div><div class="card-value">R$ ${fmtMoney(totais?.cartao)}</div></div>` : '';

      this._renderTabela();
    }
  },

  _renderTabela() {
    const thead = document.getElementById('vendas-thead');
    const tbody = document.getElementById('vendas-tbody');
    if (!tbody) return;

    const nuvem = this._todoTerminais;
    const cols = 10;

    if (thead) thead.innerHTML = `<tr>
      <th style="width:32px"><input type="checkbox" title="Selecionar todas" onchange="Vendas.toggleTodasSel(this)"></th>
      ${this._thSort('numero', '#')}
      ${this._thSort('data', 'Data / Hora')}
      <th>${nuvem ? 'Terminal' : 'Terminal'}</th>
      ${this._thSort('cliente', 'Cliente')}
      ${this._thSort('pagamento', 'Pagamento')}
      ${this._thSort('total', 'Total')}
      ${this._thSort('status', 'Status')}
      <th>Nuvem</th>
      <th></th>
    </tr>`;

    const lista = this._sortLista(this._lista);

    if (!lista.length) {
      tbody.innerHTML = `<tr><td colspan="${cols}"><div class="empty-state"><div class="icon">🧾</div><h3>Sem vendas nesta data</h3></div></td></tr>`;
      return;
    }

    tbody.innerHTML = lista.map(v => {
      const id = v.id || v.remote_id;
      const sel = this._sel.has(id);
      const cancelada = v.status === 'cancelada';
      const dt = v.created_at || v.created_date;
      const dataFmt = dt ? new Date(dt).toLocaleDateString('pt-BR', {day:'2-digit',month:'2-digit'}) : '—';
      const horaFmt = dt ? new Date(dt).toLocaleTimeString('pt-BR', {hour:'2-digit',minute:'2-digit'}) : '—';
      const pgBadge = v.forma_pagamento === 'pix' ? 'badge-green' : v.forma_pagamento === 'dinheiro' ? 'badge-yellow' : 'badge-blue';
      const terminal = nuvem ? (v.terminal_id || '—') : 'Este terminal';

      const syncBadge = nuvem
        ? '<span class="badge badge-green" title="Sincronizado">☁ Sync</span>'
        : v.remote_id
          ? '<span class="badge badge-green" title="Sincronizado">☁ Sync</span>'
          : v.sync_status === 'pending'
            ? '<span class="badge badge-yellow" title="Aguardando">⏳ Pendente</span>'
            : '<span class="badge badge-red" title="Erro">✕ Erro</span>';

      return `<tr style="${sel ? 'background:var(--accent-soft,rgba(108,99,255,.08))' : ''}">
        <td><input type="checkbox" ${sel ? 'checked' : ''} ${cancelada ? 'disabled' : ''} onchange="Vendas.toggleSel('${id}',this)"></td>
        <td class="td-mono" style="font-size:13px;font-weight:600;color:var(--accent)">#${v.numero || '—'}</td>
        <td>
          <div style="font-size:13px;font-weight:500">${horaFmt}</div>
          <div style="font-size:11px;color:var(--text3)">${dataFmt}</div>
        </td>
        <td style="font-size:11px;color:var(--text3)">${terminal}</td>
        <td>
          ${v.cliente_nome
            ? `<div style="font-size:13px;font-weight:600;color:var(--text1)">${v.cliente_nome}</div>`
            : `<span style="color:var(--text3);font-size:12px">—</span>`}
        </td>
        <td><span class="badge ${pgBadge}">${v.forma_pagamento || '—'}</span></td>
        <td style="font-size:15px;font-weight:700;color:var(--accent);white-space:nowrap">R$ ${fmtMoney(v.total)}</td>
        <td>${cancelada ? '<span class="badge badge-red">Cancelada</span>' : '<span class="badge badge-green">Concluída</span>'}</td>
        <td>${syncBadge}</td>
        <td style="display:flex;gap:4px;flex-wrap:wrap;min-width:120px">
          ${nuvem
            ? `<button class="btn btn-ghost btn-sm" onclick="Vendas.imprimirCloud(${JSON.stringify(v).replace(/"/g,'&quot;')})" title="Imprimir">🖨️</button>
               ${!cancelada ? `<button class="btn btn-ghost btn-sm" style="color:#25D366" title="Enviar por WhatsApp" onclick="${v.cliente_telefone ? `WA.abrirModal('Enviar cupom via WhatsApp','${(v.cliente_telefone||'').replace(/'/g,"\\'")}','venda','${id}',WA._vendas['${id}'])` : `WA.abrirModalCapturaCliente('venda','${id}','${(v.cliente_nome||'').replace(/'/g,"\\'")}',WA._vendas['${id}'])` }">📱</button>` : ''}`
            : `<button class="btn btn-ghost btn-sm" onclick="Vendas.imprimir('${id}')" title="Imprimir">🖨️</button>
               ${!cancelada && podePermissao('editar_venda') ? `<button class="btn btn-ghost btn-sm" style="color:var(--accent)" onclick="Vendas.editarNoPDV('${id}')">✏️</button>` : ''}
               ${!cancelada && v.nfce_emitida
                 ? `<span class="badge badge-green" title="NFC-e emitida · Chave: ${v.nfce_chave || ''}">✅ NFC-e</span>
                    ${v.nfce_url_pdf ? `<button class="btn btn-ghost btn-sm" style="color:var(--green);font-size:10px" onclick="window.open('${v.nfce_url_pdf}','_blank')" title="Ver DANFE">📄 DANFE</button>` : ''}`
                 : !cancelada ? `<button class="btn btn-ghost btn-sm" style="color:var(--green);font-size:10px" onclick="Vendas.emitirNFCe('${id}')" title="Emitir NFC-e">🧾 NFC-e</button>` : ''}
               ${!cancelada ? `<button class="btn btn-ghost btn-sm" style="color:#25D366" title="Enviar por WhatsApp" onclick="${v.cliente_telefone ? `WA.abrirModal('Enviar cupom via WhatsApp','${(v.cliente_telefone||'').replace(/'/g,"\\'")}','venda','${id}',WA._vendas['${id}'])` : `WA.abrirModalCapturaCliente('venda','${id}','${(v.cliente_nome||'').replace(/'/g,"\\'")}',WA._vendas['${id}'])` }">📱</button>` : ''}
               ${!cancelada ? `<button class="btn btn-danger btn-sm" onclick="Vendas.cancelar('${id}')">Cancelar</button>` : ''}`}
        </td>
      </tr>`;
    }).join('');
    WA._vendas = WA._vendas || {};
    lista.forEach(v => { WA._vendas[v.id || v.remote_id] = v; });
  },

  async nfceLote() {
    if (!this._sel.size) return;
    const ids = [...this._sel];
    const ok = await window.pdv.app.confirm(`Emitir NFC-e para ${ids.length} venda(s) selecionada(s)?`);
    if (!ok) return;

    let sucesso = 0, erros = 0;
    Toast.show(`Emitindo NFC-e para ${ids.length} venda(s)...`, 'info', 10000);

    for (const id of ids) {
      try {
        const venda = await window.pdv.vendas.getById(id);
        if (!venda || venda.status === 'cancelada') continue;
        const res = await window.pdv.nfce.emitir(venda);
        if (res.ok || res.aguardando) sucesso++;
        else { erros++; console.warn('[NFCe lote] Erro venda', id, res.erro); }
      } catch(e) {
        erros++;
        console.error('[NFCe lote] Exceção venda', id, e);
      }
    }

    this._sel.clear();
    this._atualizarBarraSel();
    this._renderTabela();

    if (erros === 0) Toast.show(`✅ ${sucesso} NFC-e(s) emitida(s) com sucesso`, 'success', 5000);
    else Toast.show(`${sucesso} emitida(s) · ${erros} com erro — verifique o cadastro fiscal dos produtos`, 'warning', 7000);
  },

  async _enviarImpressao(dados) {
    const ip = await window.pdv.config.get('config.print_server_ip');
    if (ip) {
      const res = await window.pdv.print.servidor(dados);
      if (res?.erro) Toast.show('Impressão: ' + res.erro, 'warning');
      else Toast.show('Enviado para impressão', 'success');
    } else {
      window.pdv.print.local(dados);
      Toast.show('Enviado para impressão', 'success');
    }
  },

  _renderPreview(numero, itens, total, subtotal, desconto, forma_pagamento, troco, vendedor_nome, cliente_nome, created_at) {
    const itensPos = itens.filter(i => i.quantidade > 0);
    const itensNeg = itens.filter(i => i.quantidade < 0);
    const linhaItem = i => `
      <div style="display:flex;justify-content:space-between;margin-bottom:4px">
        <span>${i.produto_nome} × ${Math.abs(i.quantidade)}</span>
        <span>R$ ${fmtMoney(Math.abs(i.total ?? i.subtotal ?? i.quantidade * i.preco_unitario))}</span>
      </div>`;
    return `
<div style="font-family:monospace;font-size:13px;line-height:1.6;max-width:360px;margin:0 auto">
  <div style="text-align:center;margin-bottom:16px">
    <div style="font-family:'Syne',sans-serif;font-size:18px;font-weight:800">PDV VARGAS</div>
    <div style="color:var(--text2);font-size:12px">Venda #${numero} — ${new Date(created_at).toLocaleString('pt-BR')}</div>
    ${vendedor_nome ? `<div style="font-size:11px;color:var(--text3)">Vendedor: ${vendedor_nome}</div>` : ''}
    ${cliente_nome  ? `<div style="font-size:11px;color:var(--text3)">Cliente: ${cliente_nome}</div>`   : ''}
  </div>
  <div style="border-top:1px dashed var(--border2);border-bottom:1px dashed var(--border2);padding:10px 0;margin:10px 0">
    ${itensPos.length ? `<div style="font-size:10px;font-weight:700;color:var(--text3);letter-spacing:1px;margin-bottom:4px">ITENS</div>${itensPos.map(linhaItem).join('')}` : ''}
    ${itensNeg.length ? `<div style="font-size:10px;font-weight:700;color:var(--red);letter-spacing:1px;margin:8px 0 4px">DEVOLUÇÕES</div>${itensNeg.map(linhaItem).join('')}` : ''}
  </div>
  ${desconto > 0 ? `<div style="display:flex;justify-content:space-between;color:var(--green)"><span>Desconto</span><span>- R$ ${fmtMoney(desconto)}</span></div>` : ''}
  <div style="display:flex;justify-content:space-between;font-family:'Syne',sans-serif;font-size:18px;font-weight:700;margin-top:10px;border-top:1px dashed var(--border2);padding-top:10px">
    <span>TOTAL</span><span style="color:var(--accent)">R$ ${fmtMoney(Math.abs(total))}</span>
  </div>
  <div style="margin-top:10px;color:var(--text2);font-size:12px">Pagamento: ${(forma_pagamento||'').toUpperCase()}</div>
  ${troco > 0 ? `<div style="color:var(--green)">Troco: R$ ${fmtMoney(troco)}</div>` : ''}
</div>`;
  },

  async imprimir(id) {
    const venda = await window.pdv.vendas.getById(id);
    if (!venda) return;
    const empresa_nome = (await window.pdv.config.get('auth.usuario'))?.empresa_nome || 'PDV Vargas';
    const dados = {
      numero: venda.numero, empresa_nome,
      vendedor_nome: venda.vendedor_nome || null,
      cliente_nome: venda.cliente_nome || null,
      itens: (venda.itens || []).map(i => ({ produto_nome: i.produto_nome, quantidade: i.quantidade, preco_unitario: i.preco_unitario, subtotal: i.total })),
      subtotal: venda.subtotal, desconto: venda.desconto || 0, total: venda.total,
      forma_pagamento: venda.forma_pagamento, valor_pago: venda.valor_pago,
      troco: venda.troco || 0, created_at: venda.created_at,
    };
    this._printDados = dados;
    const preview = this._renderPreview(venda.numero, venda.itens, venda.total, venda.subtotal, venda.desconto || 0, venda.forma_pagamento, venda.troco || 0, venda.vendedor_nome, venda.cliente_nome, venda.created_at);
    Modal.open(`${preview}<div class="modal-actions"><button class="btn btn-ghost" onclick="Modal.close()">Fechar</button><button class="btn btn-primary" onclick="Vendas._confirmarImpressao()">🖨️ Imprimir</button></div>`, `Comprovante #${venda.numero}`, '');
  },

  async _confirmarImpressao() {
    Modal.close();
    if (this._printDados) await this._enviarImpressao(this._printDados);
    this._printDados = null;
  },

  async imprimirCloud(v) {
    const empresa_nome = (await window.pdv.config.get('auth.usuario'))?.empresa_nome || 'PDV Vargas';
    const itens = (v.itens || []).map(i => ({ produto_nome: i.produto_nome, quantidade: i.quantidade, preco_unitario: i.preco_unitario, subtotal: i.subtotal || i.quantidade * i.preco_unitario }));
    const dados = {
      numero: v.numero, empresa_nome,
      vendedor_nome: v.vendedor_nome || null, cliente_nome: v.cliente_nome || null,
      itens, subtotal: v.subtotal || v.total, desconto: v.desconto_total || 0,
      total: v.total, forma_pagamento: v.forma_pagamento,
      valor_pago: v.valor_recebido || v.total, troco: v.troco || 0, created_at: v.created_date,
    };
    this._printDados = dados;
    const preview = this._renderPreview(v.numero, itens, v.total, v.subtotal || v.total, v.desconto_total || 0, v.forma_pagamento, v.troco || 0, v.vendedor_nome, v.cliente_nome, v.created_date);
    Modal.open(`${preview}<div class="modal-actions"><button class="btn btn-ghost" onclick="Modal.close()">Fechar</button><button class="btn btn-primary" onclick="Vendas._confirmarImpressao()">🖨️ Imprimir</button></div>`, `Comprovante #${v.numero}`, '');
  },

  async editarNoPDV(id) {
    const venda = await window.pdv.vendas.getById(id);
    if (!venda) { Toast.show('Venda não encontrada', 'error'); return; }
    if (venda.status === 'cancelada') { Toast.show('Não é possível editar venda cancelada', 'warning'); return; }
    // Carregar venda no PDV em modo de edição
    App.navigate('pdv');
    setTimeout(() => PDV.entrarModoEdicao(venda), 100);
  },

  async cancelar(id) {
    const motivo = prompt('Motivo do cancelamento:');
    if (!motivo) return;
    const ok = await window.pdv.app.confirm(`Cancelar esta venda? Motivo: ${motivo}`);
    if (!ok) return;
    await window.pdv.vendas.cancelar(id, motivo);
    Toast.show('Venda cancelada', 'warning');
    await this.load();
  },

  async emitirNFCe(id) {
    const venda = await window.pdv.vendas.getById(id);
    if (!venda) { Toast.show('Venda não encontrada', 'error'); return; }

    Toast.show('Emitindo NFC-e...', 'info', 5000);
    const res = await window.pdv.nfce.emitir(venda);

    if (res.ok || res.aguardando) {
      if (res.aguardando) {
        Toast.show('Aguardando autorização da SEFAZ...', 'info', 4000);
        await new Promise(r => setTimeout(r, 5000));
        const consulta = await window.pdv.nfce.consultar(res.reference);
        if (consulta.status === 'autorizado') {
          this._abrirResultadoNFCe(res.reference, consulta, venda.remote_id, id);
        } else {
          Toast.show(`Status: ${consulta.status || 'aguardando'} — consulte em instantes`, 'warning', 5000);
        }
      } else {
        this._abrirResultadoNFCe(res.reference, res.data, venda.remote_id, id);
      }
    } else {
      Modal.open(`
        <div style="padding:16px">
          <div style="color:var(--red);font-size:14px;font-weight:600;margin-bottom:8px">❌ Erro na emissão</div>
          <div style="font-size:13px;color:var(--text2);word-break:break-word">${res.erro || 'Erro desconhecido'}</div>
          <div class="modal-actions"><button class="btn btn-ghost" onclick="Modal.close()">Fechar</button></div>
        </div>`, 'NFC-e — Erro');
    }
  },

  _abrirResultadoNFCe(reference, data, remoteId, localId) {
    const chave = data?.chave_nfe || data?.chave || '—';
    const protocolo = data?.numero_protocolo || data?.protocolo || '—';
    const danfeUrl = data?.danfe_url || data?.url_danfe_nfce || null;

    // Salvar localmente
    if (localId) {
      window.pdv.vendas.atualizarNfce(localId, {
        chave: data?.chave_nfe || data?.chave || '',
        numero: data?.numero || '',
        serie: data?.serie || '',
        url_pdf: danfeUrl || '',
        referencia: reference,
      }).catch(() => {});
    }

    // Sincronizar com Base44 em background
    if (remoteId) {
      window.pdv.nfce.registrarBase44(remoteId, {
        chave:        data?.chave_nfe || data?.chave || '',
        numero:       data?.numero || '',
        serie:        data?.serie || '',
        status:       data?.status || 'autorizado',
        status_sefaz: data?.status_sefaz || '100',
        motivo_sefaz: data?.motivo || '',
        danfe_url:    danfeUrl || '',
        url_xml:      data?.url_xml || '',
        referencia:   reference,
      }).catch(e => console.warn('[NFCe sync Base44]', e.message));
    }

    Modal.open(`
      <div style="padding:16px;text-align:center">
        <div style="font-size:32px;margin-bottom:8px">✅</div>
        <div style="font-size:15px;font-weight:700;margin-bottom:4px">NFC-e Autorizada!</div>
        <div style="font-size:11px;color:var(--text3);margin-bottom:16px">Ref: ${reference}</div>
        <div style="background:var(--bg3);border-radius:8px;padding:12px;margin-bottom:16px;text-align:left">
          <div style="font-size:10px;color:var(--text3);margin-bottom:4px">CHAVE DE ACESSO</div>
          <div style="font-size:11px;font-family:monospace;word-break:break-all">${chave}</div>
          <div style="font-size:10px;color:var(--text3);margin-top:8px;margin-bottom:4px">PROTOCOLO</div>
          <div style="font-size:12px;font-weight:600">${protocolo}</div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" onclick="Modal.close()">Fechar</button>
          ${danfeUrl ? `<button class="btn btn-primary" onclick="window.open('${danfeUrl}','_blank')">📄 Abrir DANFE</button>` : ''}
        </div>
      </div>`, 'NFC-e Emitida');
  }
};

// ─── Launcher ─────────────────────────────────────────────────────
const Launcher = {
  _modulos: [
    {
      id: 'pdv',
      icon: '🛒',
      titulo: 'Frente de Caixa',
      desc: 'Vendas no balcão, pagamentos e emissão de NFC-e',
      tags: ['PDV', 'NFC-e'],
      status: 'ativo',
      cor: '#6c63ff',
    },
    {
      id: 'gestao',
      icon: '📊',
      titulo: 'Gestão',
      desc: 'Produtos, estoque, clientes, vendas e relatórios',
      tags: ['Produtos', 'Estoque', 'Clientes'],
      status: 'ativo',
      cor: '#22c55e',
    },
    {
      id: 'marketplace',
      icon: '🛍️',
      titulo: 'Marketplace',
      desc: 'Integração com Mercado Livre, Shopee e outros canais',
      tags: ['Shopee', 'Canais', 'Pedidos'],
      status: 'ativo',
      cor: '#f59e0b',
    },
    {
      id: 'fiscal',
      icon: '📄',
      titulo: 'Fiscal / NF-e',
      desc: 'Emissão de NF-e, relatórios fiscais e SPED',
      tags: ['NF-e', 'SPED'],
      status: 'breve',
      cor: '#3b82f6',
    },
    {
      id: 'financeiro',
      icon: '💰',
      titulo: 'Financeiro',
      desc: 'Contas a receber, fluxo de caixa e DRE',
      tags: ['Contas', 'Fluxo de Caixa'],
      status: 'breve',
      cor: '#10b981',
    },
    {
      id: 'bi',
      icon: '📈',
      titulo: 'Relatórios & BI',
      desc: 'Dashboard de métricas, metas e desempenho de vendas',
      tags: ['Dashboard', 'Metas'],
      status: 'breve',
      cor: '#ec4899',
    },
  ],

  async render() {
    const user = await window.pdv.config.get('auth.usuario');
    const nome = user?.nome?.split(' ')[0] || 'Operador';
    const empresa = user?.empresa_nome || 'Sistema Vargas';
    const hora = new Date().getHours();
    const saudacao = hora < 12 ? 'Bom dia' : hora < 18 ? 'Boa tarde' : 'Boa noite';

    const cards = this._modulos.map(m => {
      const ativo = m.status === 'ativo';
      const tags = m.tags.map(t => `<span style="
        font-size:9px;font-weight:600;letter-spacing:.5px;text-transform:uppercase;
        background:${m.cor}18;color:${m.cor};border:1px solid ${m.cor}33;
        border-radius:4px;padding:2px 6px">${t}</span>`).join('');

      return `
      <div onclick="${ativo ? `Launcher.entrar('${m.id}')` : ''}" style="
        background:var(--card);border:1px solid var(--border);border-radius:16px;
        padding:28px 24px;cursor:${ativo ? 'pointer' : 'default'};
        position:relative;overflow:hidden;
        transition:transform .15s,box-shadow .15s,border-color .15s;
        ${!ativo ? 'opacity:.55;filter:grayscale(.4)' : ''}
      "
      ${ativo ? `onmouseenter="this.style.transform='translateY(-3px)';this.style.boxShadow='0 12px 32px rgba(0,0,0,.18)';this.style.borderColor='${m.cor}44'"
        onmouseleave="this.style.transform='';this.style.boxShadow='';this.style.borderColor=''"` : ''}>

        <!-- barra de cor no topo -->
        <div style="position:absolute;top:0;left:0;right:0;height:3px;background:${m.cor};border-radius:16px 16px 0 0"></div>

        ${!ativo ? `<div style="position:absolute;top:14px;right:14px;background:var(--bg3);color:var(--text3);font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;border-radius:20px;padding:3px 10px;border:1px solid var(--border2)">EM BREVE</div>` : `<div style="position:absolute;top:14px;right:14px;background:${m.cor}22;color:${m.cor};font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;border-radius:20px;padding:3px 10px">● ATIVO</div>`}

        <div style="font-size:36px;margin-bottom:14px;line-height:1">${m.icon}</div>
        <div style="font-size:16px;font-weight:700;color:var(--text1);margin-bottom:6px">${m.titulo}</div>
        <div style="font-size:12px;color:var(--text2);line-height:1.5;margin-bottom:14px;min-height:36px">${m.desc}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${tags}</div>

        ${ativo ? `<div style="margin-top:20px;display:flex;align-items:center;gap:6px;color:${m.cor};font-size:12px;font-weight:600">
          Acessar <span style="font-size:16px">→</span>
        </div>` : ''}
      </div>`;
    }).join('');

    return `
<div style="
  min-height:100vh;width:100%;
  background:var(--bg);
  display:flex;flex-direction:column;
  overflow-y:auto;
">
  <!-- Header -->
  <div style="
    padding:40px 48px 32px;
    background:linear-gradient(135deg,var(--card) 0%,var(--bg) 100%);
    border-bottom:1px solid var(--border);
    display:flex;align-items:center;justify-content:space-between;
  ">
    <div>
      <div style="font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:var(--accent);margin-bottom:6px">${empresa}</div>
      <div style="font-size:28px;font-weight:800;color:var(--text1);font-family:'Syne',sans-serif">${saudacao}, ${nome}! 👋</div>
      <div style="font-size:13px;color:var(--text2);margin-top:4px">Selecione um módulo para continuar</div>
    </div>
    <div style="display:flex;align-items:center;gap:16px">
      <div style="text-align:right">
        <div style="font-size:11px;color:var(--text3)">Sistema Vargas</div>
        <div id="launcher-version" style="font-size:10px;color:var(--text3);opacity:.6"></div>
      </div>
      <button onclick="App.logout()" style="
        background:var(--bg3);border:1px solid var(--border2);border-radius:10px;
        padding:8px 16px;color:var(--text2);font-size:12px;cursor:pointer;
      ">Sair</button>
    </div>
  </div>

  <!-- Grid de módulos -->
  <div style="
    flex:1;padding:40px 48px;
    display:grid;
    grid-template-columns:repeat(auto-fill,minmax(280px,1fr));
    gap:20px;
    align-content:start;
  ">
    ${cards}
  </div>

  <!-- Rodapé -->
  <div style="padding:20px 48px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between">
    <span style="font-size:11px;color:var(--text3)">© 2025 Sistema Vargas · Todos os direitos reservados</span>
    <span id="launcher-sync" style="font-size:11px;color:var(--text3)"></span>
  </div>
</div>`;
  },

  async init() {
    const el = document.getElementById('launcher-screen');
    if (!el) return;
    el.innerHTML = await this.render();
    // versão
    const ver = await window.pdv.app.version().catch(() => '');
    const vEl = document.getElementById('launcher-version');
    if (vEl && ver) vEl.textContent = `v${ver}`;
  },

  entrar(modulo) {
    document.getElementById('launcher-screen').style.display = 'none';
    document.getElementById('main-layout').style.display = 'flex';
    if (modulo === 'pdv') {
      App.navigate('pdv');
    } else if (modulo === 'gestao') {
      App.navigate('vendas');
    } else if (modulo === 'marketplace') {
      App.navigate('marketplace');
    }
  },
};

// ─── Estoque ──────────────────────────────────────────────────────
const Estoque = {
  render() {
    return `
<div class="page-header">
  <div><div class="page-title">Estoque</div><div class="page-sub">Alertas e movimentações</div></div>
</div>
<div style="flex:1;overflow:auto;padding:20px 24px">
  <div style="margin-bottom:20px;font-size:12px;text-transform:uppercase;letter-spacing:1.5px;color:var(--text3)">⚠️ Alertas de estoque baixo</div>
  <div class="table-wrap">
    <table>
      <thead><tr><th>Produto</th><th>SKU</th><th>Estoque atual</th><th>Mínimo</th><th>Situação</th><th></th></tr></thead>
      <tbody id="est-tbody"></tbody>
    </table>
  </div>
</div>`;
  },

  async init() {
    const alertas = await window.pdv.estoque.alertas();
    const tbody = document.getElementById('est-tbody');
    if (!tbody) return;
    tbody.innerHTML = alertas.map(a => `
      <tr>
        <td class="td-main">${a.nome}</td>
        <td class="td-mono">${a.sku || '-'}</td>
        <td><span style="color:${a.quantidade===0?'var(--red)':'var(--orange)'};font-weight:600">${a.quantidade}</span></td>
        <td>${a.quantidade_minima}</td>
        <td>${a.quantidade===0?'<span class="badge badge-red">Zerado</span>':'<span class="badge badge-orange">Baixo</span>'}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="Estoque.ajustar('${a.id}','${a.nome.replace(/'/g,'\\')}')">Ajustar</button></td>
      </tr>`).join('') || '<tr><td colspan="6"><div class="empty-state"><div class="icon">✅</div><h3>Nenhum alerta de estoque</h3></div></td></tr>';
  },

  async ajustar(produtoId, nome) {
    Modal.open(`
<div class="form-group">
  <label class="form-label">Tipo de movimentação</label>
  <select class="input" id="mov-tipo">
    <option value="entrada">Entrada (recebimento)</option>
    <option value="ajuste">Ajuste de inventário</option>
    <option value="saida">Saída (perda/quebra)</option>
  </select>
</div>
<div class="form-group">
  <label class="form-label">Quantidade</label>
  <input class="input" id="mov-qty" type="number" step="0.001" min="0" placeholder="0">
</div>
<div class="form-group">
  <label class="form-label">Observação</label>
  <input class="input" id="mov-obs" placeholder="Ex: Recebimento NF 12345">
</div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
  <button class="btn btn-primary" onclick="Estoque.salvarMov('${produtoId}')">Registrar</button>
</div>`, `Movimentação — ${nome}`);
  },

  async salvarMov(produtoId) {
    const tipo = document.getElementById('mov-tipo').value;
    const qty = parseFloat(document.getElementById('mov-qty').value);
    const obs = document.getElementById('mov-obs').value;
    if (!qty || qty <= 0) { Toast.show('Quantidade inválida', 'error'); return; }
    await window.pdv.estoque.movimentar({ produto_id: produtoId, tipo, quantidade: qty, observacao: obs });
    Toast.show('Movimentação registrada!', 'success');
    Modal.close();
    await this.init();
  }
};

// ─── Faltas / Encomendas ─────────────────────────────────────────
const Faltas = (() => {
  let _lista = [];
  let _filtroStatus = '';
  let _busca = '';

  const STATUS_LABEL = {
    pendente:   { label: 'Pendente',   cor: '#eab308', bg: '#fef9c3' },
    notificado: { label: 'Notificado', cor: '#3b82f6', bg: '#dbeafe' },
    comprado:   { label: 'Comprado',   cor: '#8b5cf6', bg: '#ede9fe' },
    atendido:   { label: 'Atendido',   cor: '#22c55e', bg: '#dcfce7' },
    cancelado:  { label: 'Cancelado',  cor: '#9ca3af', bg: '#f3f4f6' },
    resolvido:  { label: 'Resolvido',  cor: '#22c55e', bg: '#dcfce7' },
    ignorado:   { label: 'Ignorado',   cor: '#9ca3af', bg: '#f3f4f6' },
  };

  function render() {
    return `
<div class="page-header">
  <div>
    <div class="page-title">Faltas & Encomendas</div>
    <div class="page-sub">Lista de produtos em falta e pedidos de clientes</div>
  </div>
  <button class="btn btn-primary" onclick="Faltas.abrirNovaFalta()">+ Registrar Falta</button>
</div>
<div style="padding:0 24px 16px;display:flex;gap:10px;align-items:center">
  <input class="input" id="faltas-busca" placeholder="Buscar produto ou cliente..."
    style="flex:1;max-width:320px"
    oninput="Faltas.setBusca(this.value)">
  <select class="input" id="faltas-status" style="width:160px" onchange="Faltas.setStatus(this.value)">
    <option value="">Todos os status</option>
    <option value="pendente">Pendente</option>
    <option value="notificado">Notificado</option>
    <option value="comprado">Comprado</option>
    <option value="atendido">Atendido</option>
    <option value="cancelado">Cancelado</option>
    <option value="resolvido">Resolvido</option>
  </select>
  <span id="faltas-count" style="font-size:12px;color:var(--text3)"></span>
</div>
<div style="flex:1;overflow:auto;padding:0 24px 24px">
  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Produto</th><th>Cliente</th><th>Qtd</th>
        <th>Observação</th><th>Status</th><th>Data</th><th>Ações</th>
      </tr></thead>
      <tbody id="faltas-tbody"></tbody>
    </table>
  </div>
</div>`;
  }

  async function init() {
    await carregar();
  }

  async function carregar() {
    _lista = await window.pdv.faltas.listar({ status: _filtroStatus, busca: _busca });
    renderTabela();
  }

  function renderTabela() {
    const tbody = document.getElementById('faltas-tbody');
    const count = document.getElementById('faltas-count');
    if (!tbody) return;

    if (count) count.textContent = `${_lista.length} registro${_lista.length !== 1 ? 's' : ''}`;

    if (_lista.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--text3)">
        Nenhuma falta registrada
      </td></tr>`;
      return;
    }

    tbody.innerHTML = _lista.map(f => {
      const s = STATUS_LABEL[f.status] || STATUS_LABEL.pendente;
      const data = f.created_at ? new Date(f.created_at).toLocaleDateString('pt-BR') : '—';
      const tel = f.cliente_telefone
        ? `<div style="font-size:10px;color:var(--text3)">${f.cliente_telefone}</div>` : '';
      const syncBadge = f.sync_status === 'synced'
        ? '<span style="font-size:9px;color:var(--text3)">☁</span>'
        : '<span style="font-size:9px;color:var(--accent)">↑</span>';
      return `<tr>
        <td>
          <div style="font-weight:600">${f.produto_nome}</div>
          ${f.produto_sku ? `<div style="font-size:10px;color:var(--text3)">${f.produto_sku}</div>` : ''}
        </td>
        <td>${f.cliente_nome ? `<div>${f.cliente_nome}</div>${tel}` : '<span style="color:var(--text3)">—</span>'}</td>
        <td style="text-align:center;font-weight:600">${f.quantidade_solicitada || 1}</td>
        <td style="max-width:180px;font-size:11px;color:var(--text2)">${f.observacao || '—'}</td>
        <td>
          <select class="input" style="font-size:11px;padding:3px 6px;height:28px;
            color:${s.cor};background:${s.bg};border-color:${s.cor}40"
            onchange="Faltas.mudarStatus('${f.id}', this.value)">
            ${Object.entries(STATUS_LABEL).map(([k, v]) =>
              `<option value="${k}" ${f.status === k ? 'selected' : ''}>${v.label}</option>`
            ).join('')}
          </select>
        </td>
        <td style="font-size:11px;color:var(--text3)">${data} ${syncBadge}</td>
        <td>
          <button class="btn btn-ghost" style="font-size:11px;padding:3px 8px"
            onclick="Faltas.abrirWhatsApp('${f.cliente_telefone || ''}', '${(f.produto_nome || '').replace(/'/g, "\\'")}')">
            📱 WA
          </button>
        </td>
      </tr>`;
    }).join('');
  }

  function setBusca(v) {
    _busca = v;
    clearTimeout(Faltas._buscaTimer);
    Faltas._buscaTimer = setTimeout(carregar, 300);
  }

  function setStatus(v) {
    _filtroStatus = v;
    carregar();
  }

  async function mudarStatus(id, status) {
    await window.pdv.faltas.atualizarStatus(id, status);
    await carregar();
  }

  function abrirNovaFalta(produto) {
    const nomeProduto = produto?.nome || '';
    const skuProduto  = produto?.sku  || '';
    const idProduto   = produto?.id   || '';
    Modal.open(`
<div style="display:flex;flex-direction:column;gap:14px">
  <div style="position:relative">
    <label class="label">Produto *</label>
    <input class="input" id="nf-produto" value="${nomeProduto}"
      placeholder="Buscar produto ou digitar manualmente..."
      autocomplete="off"
      oninput="Faltas._buscarProduto(this.value)"
      onkeydown="Faltas._navBusca(event)">
    <input type="hidden" id="nf-produto-id" value="${idProduto}">
    <input type="hidden" id="nf-produto-sku" value="${skuProduto}">
    <div id="nf-resultados" style="display:none;position:absolute;left:0;right:0;top:100%;
      background:var(--bg2);border:1px solid var(--border2);border-radius:8px;
      box-shadow:var(--shadow);z-index:9999;max-height:220px;overflow-y:auto;margin-top:2px"></div>
    <div id="nf-produto-badge" style="display:none;margin-top:6px;padding:5px 10px;
      background:var(--green-bg);border:1px solid var(--green-border);border-radius:6px;
      font-size:11px;color:var(--green);display:flex;align-items:center;gap:6px">
      <span>✓</span><span id="nf-produto-badge-nome"></span>
      <button onclick="Faltas._limparProduto()" style="margin-left:auto;background:none;border:none;
        cursor:pointer;color:var(--text3);font-size:13px;padding:0">✕</button>
    </div>
  </div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
    <div>
      <label class="label">Quantidade</label>
      <input class="input" id="nf-qty" type="number" min="1" value="1">
    </div>
    <div>
      <label class="label">Status</label>
      <select class="input" id="nf-status">
        <option value="pendente">Pendente</option>
        <option value="comprado">Comprado</option>
      </select>
    </div>
  </div>
  <div>
    <label class="label">Cliente (opcional)</label>
    <input class="input" id="nf-cliente" placeholder="Nome do cliente">
  </div>
  <div>
    <label class="label">Telefone / WhatsApp</label>
    <input class="input" id="nf-tel" placeholder="(21) 99999-9999">
  </div>
  <div>
    <label class="label">Observação</label>
    <input class="input" id="nf-obs" placeholder="Quantidade, prazo, detalhes...">
  </div>
</div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
  <button class="btn btn-primary btn-lg" onclick="Faltas.confirmarNovaFalta()">Registrar Falta</button>
</div>`, 'Registrar Falta / Encomenda');

    // Pre-preencher se veio com produto já conhecido
    if (idProduto) _marcarProdutoSelecionado({ id: idProduto, nome: nomeProduto, sku: skuProduto });
    setTimeout(() => document.getElementById('nf-produto')?.focus(), 80);
  }

  let _nfResultados = [];
  let _nfHighlight = -1;
  let _nfTimer = null;
  let _nfProdutoSelecionado = null;

  async function _buscarProduto(val) {
    _nfProdutoSelecionado = null;
    document.getElementById('nf-produto-id').value = '';
    document.getElementById('nf-produto-sku').value = '';
    const badge = document.getElementById('nf-produto-badge');
    if (badge) badge.style.display = 'none';

    const box = document.getElementById('nf-resultados');
    if (!val.trim()) { box.style.display = 'none'; return; }

    clearTimeout(_nfTimer);
    _nfTimer = setTimeout(async () => {
      _nfResultados = await window.pdv.produtos.buscar(val);
      _nfHighlight = -1;

      if (!_nfResultados.length) {
        box.innerHTML = `<div style="padding:12px 14px;font-size:12px;color:var(--text3)">
          Produto não encontrado — será registrado como "<strong>${val}</strong>" (sem vínculo no cadastro)
        </div>`;
      } else {
        box.innerHTML = _nfResultados.map((p, i) => `
          <div id="nf-ri-${i}" onclick="Faltas._selecionarProduto(${i})"
            style="padding:10px 14px;cursor:pointer;display:flex;align-items:center;gap:10px;
              border-bottom:1px solid var(--border);font-size:12px"
            onmouseenter="Faltas._hlProduto(${i})"
            onmouseleave="Faltas._hlProduto(-1)">
            <span style="font-size:18px">📦</span>
            <div style="flex:1">
              <div style="font-weight:600">${p.nome}</div>
              <div style="color:var(--text3);font-size:10px">${p.sku || ''} ${p.ean ? '· ' + p.ean : ''}</div>
            </div>
            <div style="text-align:right">
              <div style="font-weight:600;color:var(--accent)">R$ ${fmtMoney(p.preco_venda)}</div>
              <div style="font-size:10px;color:${p.estoque > 0 ? 'var(--green)' : 'var(--red)'}">
                ${p.estoque > 0 ? `📦 ${p.estoque}` : '❌ Sem estoque'}
              </div>
            </div>
          </div>`).join('');
      }
      box.style.display = 'block';
    }, 180);
  }

  function _hlProduto(i) {
    _nfResultados.forEach((_, j) => {
      const el = document.getElementById(`nf-ri-${j}`);
      if (el) el.style.background = j === i ? 'var(--bg3)' : '';
    });
    _nfHighlight = i;
  }

  function _navBusca(e) {
    if (!['ArrowDown','ArrowUp','Enter','Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') { document.getElementById('nf-resultados').style.display = 'none'; return; }
    if (e.key === 'Enter' && _nfHighlight >= 0) { _selecionarProduto(_nfHighlight); return; }
    if (e.key === 'Enter' && _nfResultados.length === 1) { _selecionarProduto(0); return; }
    const next = e.key === 'ArrowDown'
      ? Math.min(_nfHighlight + 1, _nfResultados.length - 1)
      : Math.max(_nfHighlight - 1, 0);
    _hlProduto(next);
  }

  function _selecionarProduto(i) {
    const p = _nfResultados[i];
    if (!p) return;
    _marcarProdutoSelecionado(p);
    document.getElementById('nf-resultados').style.display = 'none';
  }

  function _marcarProdutoSelecionado(p) {
    _nfProdutoSelecionado = p;
    const input = document.getElementById('nf-produto');
    if (input) input.value = p.nome;
    const idEl = document.getElementById('nf-produto-id');
    if (idEl) idEl.value = p.id || '';
    const skuEl = document.getElementById('nf-produto-sku');
    if (skuEl) skuEl.value = p.sku || '';
    const badge = document.getElementById('nf-produto-badge');
    const badgeNome = document.getElementById('nf-produto-badge-nome');
    if (badge && badgeNome) {
      badgeNome.textContent = `${p.nome}${p.sku ? ' · ' + p.sku : ''} — vinculado ao cadastro`;
      badge.style.display = 'flex';
    }
  }

  function _limparProduto() {
    _nfProdutoSelecionado = null;
    const input = document.getElementById('nf-produto');
    if (input) { input.value = ''; input.focus(); }
    document.getElementById('nf-produto-id').value = '';
    document.getElementById('nf-produto-sku').value = '';
    const badge = document.getElementById('nf-produto-badge');
    if (badge) badge.style.display = 'none';
  }

  async function confirmarNovaFalta() {
    const nome = document.getElementById('nf-produto')?.value?.trim();
    if (!nome) { App.toast('Informe o nome do produto', 'error'); return; }
    const falta = {
      produto_id:           document.getElementById('nf-produto-id')?.value || null,
      produto_nome:         nome,
      produto_sku:          document.getElementById('nf-produto-sku')?.value || null,
      quantidade_solicitada: parseFloat(document.getElementById('nf-qty')?.value) || 1,
      cliente_nome:         document.getElementById('nf-cliente')?.value?.trim() || null,
      cliente_telefone:     document.getElementById('nf-tel')?.value?.trim() || null,
      observacao:           document.getElementById('nf-obs')?.value?.trim() || null,
      status:               document.getElementById('nf-status')?.value || 'pendente',
      origem: 'pdv',
    };
    await window.pdv.faltas.registrar(falta);
    Modal.close();
    App.toast('Falta registrada!', 'success');
    await carregar();
  }

  function abrirWhatsApp(telefone, produto) {
    if (!telefone) { App.toast('Cliente sem telefone cadastrado', 'warning'); return; }
    const num = telefone.replace(/\D/g, '');
    const msg = encodeURIComponent(`Olá! O produto "${produto}" que você solicitou chegou. Venha buscar!`);
    // Abre link externo — requer shell.openExternal no main ou link direto
    window.open(`https://wa.me/55${num}?text=${msg}`, '_blank');
  }

  return {
    render, init, carregar, setBusca, setStatus,
    mudarStatus, abrirNovaFalta, confirmarNovaFalta, abrirWhatsApp,
    _buscarProduto, _navBusca, _selecionarProduto, _marcarProdutoSelecionado,
    _limparProduto, _hlProduto,
  };
})();

// ─── Config ───────────────────────────────────────────────────────
const Config = {
  render() {
    return `
<div class="page-header">
  <div><div class="page-title">Configurações</div></div>
</div>
<div style="padding:24px;max-width:560px;overflow:auto">
  <div class="card" style="margin-bottom:16px">
    <div style="font-size:13px;font-weight:600;margin-bottom:14px">🔌 Conexão Base44</div>
    <div class="form-group"><label class="form-label">App ID</label><input class="input" id="cfg-appid" placeholder="seu-app-id"></div>
    <div class="form-group"><label class="form-label">Terminal ID</label><input class="input" id="cfg-terminal" placeholder="PDV-001"></div>
    <div class="form-group"><label class="form-label">Intervalo de sync (minutos)</label><input class="input" id="cfg-interval" type="number" min="1" max="60" value="5"></div>
    <button class="btn btn-primary btn-sm" onclick="Config.salvar()">Salvar</button>
  </div>
  <div class="card" style="margin-bottom:16px">
    <div style="font-size:13px;font-weight:600;margin-bottom:14px">🔄 Sincronização</div>
    <div id="cfg-sync-info" style="font-size:13px;color:var(--text2);margin-bottom:12px">Carregando...</div>
    <div class="flex gap-8">
      <button class="btn btn-ghost btn-sm" onclick="App.syncNow()">↻ Sincronizar agora</button>
      <button class="btn btn-ghost btn-sm" onclick="Config.syncPendentes()">Ver pendentes</button>
    </div>
  </div>
  <div class="card" style="margin-bottom:16px">
    <div style="font-size:13px;font-weight:600;margin-bottom:14px">🛒 Comportamento do PDV</div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div>
        <div style="font-size:13px;font-weight:500">Permitir venda com estoque negativo</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">Permite vender mesmo sem estoque disponível</div>
      </div>
      <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0">
        <input type="checkbox" id="cfg-estoque-negativo" style="opacity:0;width:0;height:0"
          onchange="Config._setToggle('cfg-estoque-negativo','cfg-toggle-estoque','cfg-toggle-knob',this.checked);Config.salvar()">
        <span id="cfg-toggle-estoque"
          style="position:absolute;cursor:pointer;inset:0;background:var(--bg3);border:1px solid var(--border2);border-radius:24px;transition:.2s">
          <span id="cfg-toggle-knob" style="position:absolute;height:18px;width:18px;left:2px;top:2px;background:var(--text3);border-radius:50%;transition:.2s"></span>
        </span>
      </label>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between">
      <div>
        <div style="font-size:13px;font-weight:500">Exigir código do vendedor</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">Obriga informar vendedor ao finalizar</div>
      </div>
      <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0">
        <input type="checkbox" id="cfg-exigir-vendedor" style="opacity:0;width:0;height:0"
          onchange="Config._setToggle('cfg-exigir-vendedor','cfg-toggle-vendedor','cfg-toggle-vendedor-knob',this.checked);Config.salvar()">
        <span id="cfg-toggle-vendedor"
          style="position:absolute;cursor:pointer;inset:0;background:var(--bg3);border:1px solid var(--border2);border-radius:24px;transition:.2s">
          <span id="cfg-toggle-vendedor-knob" style="position:absolute;height:18px;width:18px;left:2px;top:2px;background:var(--text3);border-radius:50%;transition:.2s"></span>
        </span>
      </label>
    </div>
  </div>
  <div class="card" style="margin-bottom:16px">
    <div style="font-size:13px;font-weight:600;margin-bottom:14px">🎨 Aparência</div>
    <div style="font-size:12px;color:var(--text2);margin-bottom:12px">Escolha o tema da interface</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px" id="cfg-tema-btns">
      <button id="cfg-tema-dark" onclick="Config.setTema('dark')"
        style="padding:14px;border-radius:10px;border:2px solid var(--border2);background:var(--bg3);cursor:pointer;transition:all .15s;text-align:center">
        <div style="font-size:22px;margin-bottom:6px">🌙</div>
        <div style="font-size:13px;font-weight:600;color:var(--text)">Escuro</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">Recomendado</div>
      </button>
      <button id="cfg-tema-light" onclick="Config.setTema('light')"
        style="padding:14px;border-radius:10px;border:2px solid var(--border2);background:var(--bg3);cursor:pointer;transition:all .15s;text-align:center">
        <div style="font-size:22px;margin-bottom:6px">☀️</div>
        <div style="font-size:13px;font-weight:600;color:var(--text)">Claro</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">Para ambientes claros</div>
      </button>
    </div>
  </div>
  <div class="card" style="margin-bottom:16px">
    <div style="font-size:13px;font-weight:600;margin-bottom:4px">🖨️ Impressão em Rede</div>
    <div style="font-size:11px;color:var(--text3);margin-bottom:14px">
      Configure este terminal como servidor de impressão (CAIXA) ou aponte para o IP do CAIXA.
    </div>

    <!-- Toggle: Servidor de impressão ativo -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div>
        <div style="font-size:13px;font-weight:500">Este terminal é o CAIXA (servidor de impressão)</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">Ativa o servidor HTTP local para receber jobs dos outros terminais</div>
      </div>
      <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0">
        <input type="checkbox" id="cfg-print-server"
          style="opacity:0;width:0;height:0"
          onchange="Config._onPrintServerToggle(this.checked)">
        <span id="cfg-toggle-print"
          style="position:absolute;cursor:pointer;inset:0;background:var(--bg3);border:1px solid var(--border2);border-radius:24px;transition:.2s">
          <span id="cfg-toggle-print-knob"
            style="position:absolute;height:18px;width:18px;left:2px;top:2px;background:var(--text3);border-radius:50%;transition:.2s"></span>
        </span>
      </label>
    </div>

    <!-- Porta (visível quando é servidor) -->
    <div id="cfg-print-server-section" style="display:none">
      <div class="form-group">
        <label class="form-label">Porta do servidor</label>
        <input class="input" id="cfg-print-porta" type="number" value="3001" min="1024" max="65535"
          placeholder="3001" style="max-width:120px">
      </div>
      <div class="form-group">
        <label class="form-label">Impressora</label>
        <div style="display:flex;gap:8px;align-items:center">
          <select class="input" id="cfg-impressora" style="flex:1"></select>
          <button class="btn btn-ghost btn-sm" onclick="Config.carregarImpressoras()">↻</button>
        </div>
        <div style="font-size:11px;color:var(--text3);margin-top:4px">Selecione a impressora térmica conectada a este terminal</div>
      </div>
      <div id="cfg-print-status" style="font-size:12px;color:var(--text3);margin-bottom:10px"></div>
      <div class="form-group" style="margin-top:12px">
        <label class="form-label">Layout do Cupom</label>
        <select class="input" id="cfg-cupom-layout">
          <option value="compacto">Compacto (fonte menor, economiza papel)</option>
          <option value="padrao" selected>Padrão (equilibrado, 72mm)</option>
          <option value="grande">Grande (fonte maior, mais legível)</option>
        </select>
        <div style="font-size:11px;color:var(--text3);margin-top:4px">Define o tamanho da fonte no cupom impresso</div>
      </div>
    </div>

    <!-- Cloudflare Tunnel (visível quando É servidor) -->
    <div id="cfg-tunnel-section" style="display:none;margin-bottom:14px;padding:12px;background:var(--bg3);border-radius:8px;border:1px solid var(--border)">
      <div style="font-size:13px;font-weight:600;margin-bottom:4px">🌐 Tunnel Cloudflare (acesso remoto)</div>
      <div style="font-size:11px;color:var(--text3);margin-bottom:10px">
        Permite que terminais em <b>outras redes</b> imprimam neste CAIXA via internet. Gratuito, sem conta necessária.
      </div>
      <div id="tunnel-status-box" style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span id="tunnel-led" style="width:10px;height:10px;border-radius:50%;background:var(--text3);flex-shrink:0"></span>
        <span id="tunnel-msg" style="font-size:12px;color:var(--text2)">Tunnel inativo</span>
      </div>
      <div id="tunnel-url-box" style="display:none;margin-bottom:10px">
        <div style="font-size:11px;color:var(--text3);margin-bottom:4px">URL pública (copie e cole nos terminais remotos):</div>
        <div style="display:flex;gap:6px;align-items:center">
          <input class="input" id="tunnel-url-display" readonly style="font-size:12px;font-family:monospace;background:var(--bg2)">
          <button class="btn btn-ghost btn-sm" onclick="Config.copiarTunnelUrl()" title="Copiar URL">📋</button>
        </div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary btn-sm" id="btn-tunnel-start" onclick="Config.iniciarTunnel()">▶ Ativar Tunnel</button>
        <button class="btn btn-danger btn-sm" id="btn-tunnel-stop" onclick="Config.pararTunnel()" style="display:none">■ Parar Tunnel</button>
      </div>
    </div>

    <!-- IP do CAIXA (visível quando NÃO é servidor) -->
    <div id="cfg-print-client-section">
      <div class="form-group">
        <label class="form-label">IP ou URL do servidor de impressão (CAIXA)</label>
        <input class="input" id="cfg-print-ip" placeholder="Ex: 192.168.1.10:3001 ou https://xxx.trycloudflare.com">
        <div style="font-size:11px;color:var(--text3);margin-top:4px">Deixe vazio para imprimir localmente. Aceita IP local ou URL do Tunnel Cloudflare.</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="Config.testarConexaoImpressao()">Testar conexão</button>
    </div>

    <!-- Toggle: Imprimir automaticamente após venda -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
      <div>
        <div style="font-size:13px;font-weight:500">Imprimir cupom automaticamente após venda</div>
        <div style="font-size:11px;color:var(--text3);margin-top:2px">Envia para impressão ao confirmar pagamento</div>
      </div>
      <label style="position:relative;display:inline-block;width:44px;height:24px;flex-shrink:0">
        <input type="checkbox" id="cfg-print-auto" style="opacity:0;width:0;height:0"
          onchange="Config._setToggle('cfg-print-auto','cfg-toggle-print-auto','cfg-toggle-print-auto-knob',this.checked);Config.salvarImpressao()">
        <span id="cfg-toggle-print-auto"
          style="position:absolute;cursor:pointer;inset:0;background:var(--bg3);border:1px solid var(--border2);border-radius:24px;transition:.2s">
          <span id="cfg-toggle-print-auto-knob"
            style="position:absolute;height:18px;width:18px;left:2px;top:2px;background:var(--text3);border-radius:50%;transition:.2s"></span>
        </span>
      </label>
    </div>

    <button class="btn btn-primary btn-sm" style="margin-top:14px" onclick="Config.salvarImpressao()">Salvar configuração de impressão</button>
  </div>

  <div class="card" style="margin-bottom:16px">
    <div style="font-size:13px;font-weight:600;margin-bottom:14px">🧾 Fiscal (NFC-e / FocusNFe)</div>
    <!-- Empresa fiscal da sessão (somente leitura — vem do login) -->
    <div id="cfg-fiscal-empresa-info" style="background:var(--bg3);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:12px;color:var(--text2)">
      Carregando dados da empresa fiscal...
    </div>
    <div class="form-group">
      <label class="form-label">Ambiente</label>
      <select class="input" id="cfg-fiscal-ambiente">
        <option value="homologacao">Homologação (testes)</option>
        <option value="producao">Produção</option>
      </select>
    </div>
    <div class="form-group">
      <label class="form-label">Token Homologação</label>
      <input class="input" id="cfg-fiscal-token" type="password" placeholder="Token de testes do FocusNFe">
      <div style="font-size:11px;color:var(--text3);margin-top:4px">Token do ambiente de testes (homologação)</div>
    </div>
    <div class="form-group">
      <label class="form-label">Token Produção</label>
      <input class="input" id="cfg-fiscal-token-producao" type="password" placeholder="Token de produção do FocusNFe">
      <div style="font-size:11px;color:var(--text3);margin-top:4px">Token do ambiente de produção — diferente do de testes</div>
    </div>
    <button class="btn btn-primary btn-sm" onclick="Config.salvarFiscal()">Salvar configuração fiscal</button>
    <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="Config.testarFiscal()">Testar conexão</button>
  </div>

  <div class="card" style="margin-bottom:16px">
    <div style="font-size:13px;font-weight:600;margin-bottom:4px">🤖 Inteligência Artificial</div>
    <div style="font-size:12px;color:var(--text3);margin-bottom:14px">Usado para sugerir NCM, CFOP e dados fiscais automaticamente no cadastro de produtos</div>
    <div id="cfg-ia-status-badge" style="display:none;margin-bottom:12px;padding:8px 12px;border-radius:8px;font-size:12px"></div>
    <div class="form-group">
      <label class="form-label">Chave API Anthropic (Claude)</label>
      <input class="input" id="cfg-anthropic-key" type="password" placeholder="sk-ant-...">
      <div style="font-size:11px;color:var(--text3);margin-top:4px">
        Obtenha em <span style="color:var(--gold)">console.anthropic.com</span> → API Keys
      </div>
    </div>
    <button class="btn btn-primary btn-sm" onclick="Config.salvarIA()">Salvar chave IA</button>
    <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="Config.testarIA()">Testar IA</button>
  </div>

  <div class="card">
    <div style="font-size:13px;font-weight:600;margin-bottom:14px">👤 Sessão</div>
    <div id="cfg-session" style="font-size:13px;color:var(--text2);margin-bottom:12px">Carregando...</div>
    <button class="btn btn-danger btn-sm" onclick="App.logout()">Sair do sistema</button>
  </div>
</div>`;
  },

  async init() {
    const cfg = await window.pdv.config.getAll();
    const f = v => document.getElementById(v);
    if (f('cfg-appid')) f('cfg-appid').value = cfg['config.app_id'] || '';
    if (f('cfg-terminal')) f('cfg-terminal').value = cfg['config.terminal_id'] || 'PDV-001';

    // Toggles — electron-store usa notação de ponto como caminho aninhado
    const estoqueNeg = await window.pdv.config.get('config.vender_estoque_negativo') === true;
    const exigirVend = await window.pdv.config.get('config.exigir_vendedor') !== false;
    this._setToggle('cfg-estoque-negativo', 'cfg-toggle-estoque', 'cfg-toggle-knob', estoqueNeg);
    this._setToggle('cfg-exigir-vendedor', 'cfg-toggle-vendedor', 'cfg-toggle-vendedor-knob', exigirVend);

    // Impressão
    const printAtivo = await window.pdv.config.get('config.print_server_ativo') === true;
    const printPorta = await window.pdv.config.get('config.print_server_porta') || 3001;
    const printIp    = await window.pdv.config.get('config.print_server_ip') || '';
    const printAuto  = await window.pdv.config.get('config.imprimir_automatico') === true;
    const cupomLayout = await window.pdv.config.get('config.cupom_layout') || 'padrao';
    const selLayout = document.getElementById('cfg-cupom-layout');
    if (selLayout) selLayout.value = cupomLayout;
    this._setToggle('cfg-print-server', 'cfg-toggle-print', 'cfg-toggle-print-knob', printAtivo);
    this._setToggle('cfg-print-auto', 'cfg-toggle-print-auto', 'cfg-toggle-print-auto-knob', printAuto);
    if (f('cfg-print-porta')) f('cfg-print-porta').value = printPorta;
    if (f('cfg-print-ip'))    f('cfg-print-ip').value    = printIp;
    if (printAtivo) {
      if (f('cfg-print-server-section')) f('cfg-print-server-section').style.display = '';
      if (f('cfg-print-client-section')) f('cfg-print-client-section').style.display = 'none';
      if (f('cfg-tunnel-section')) f('cfg-tunnel-section').style.display = '';
      await this.carregarImpressoras();
      const status = await window.pdv.print.serverStatus();
      const el = f('cfg-print-status');
      if (el) el.textContent = status.rodando ? `🟢 Servidor ativo na porta ${status.porta}` : '⭕ Servidor inativo';
      // Verificar status atual do tunnel
      const ts = await window.pdv.tunnel.status();
      if (ts) this._atualizarUiTunnel({ estado: ts.ativo ? 'ativo' : 'parado', url: ts.url, mensagem: ts.ativo ? `Tunnel ativo: ${ts.url}` : 'Tunnel inativo' });
      window.pdv.tunnel.onStatus((s) => this._atualizarUiTunnel(s));
    }

    const temaAtual = await window.pdv.config.get('config.tema') || 'dark';
    this._marcarTema(temaAtual);

    const status = await window.pdv.sync.status();
    const si = f('cfg-sync-info');
    if (si) si.innerHTML = `
      Status: <strong>${status.online ? '🟢 Online' : '🔴 Offline'}</strong><br>
      Última sync: ${status.ultima_sync ? new Date(status.ultima_sync).toLocaleString('pt-BR') : 'Nunca'}<br>
      Pendentes: ${status.pendentes || 0} operações`;

    // IA — chave Anthropic
    const iaKey = await window.pdv.config.get('config.anthropic_key') || '';
    if (f('cfg-anthropic-key')) f('cfg-anthropic-key').value = iaKey ? '••••••••••••••••' : '';
    const iaStatus = await window.pdv.ia.status();
    this._atualizarBadgeIA(iaStatus.configurado);

    // Fiscal — tokens por ambiente; CNPJ/empresa vêm do login (Base44)
    if (f('cfg-fiscal-token'))          f('cfg-fiscal-token').value          = await window.pdv.config.get('config.fiscal_token')          || '';
    if (f('cfg-fiscal-token-producao')) f('cfg-fiscal-token-producao').value = await window.pdv.config.get('config.fiscal_token_producao') || '';
    if (f('cfg-fiscal-ambiente'))       f('cfg-fiscal-ambiente').value       = await window.pdv.config.get('config.fiscal_ambiente')       || 'homologacao';

    // Painel informativo da empresa fiscal (dados da sessão)
    const user = await window.pdv.config.get('auth.usuario');
    const infoEl = f('cfg-fiscal-empresa-info');
    if (infoEl) {
      if (user?.empresa_fiscal_cnpj) {
        infoEl.innerHTML = `
          <div style="display:grid;gap:4px">
            <div style="font-size:10px;color:var(--text3);font-weight:700;letter-spacing:.5px">EMPRESA FISCAL (do login Base44)</div>
            <div><strong>${user.empresa_fiscal_nome || '-'}</strong></div>
            <div style="font-family:monospace">CNPJ: ${user.empresa_fiscal_cnpj}</div>
            ${user.empresa_fiscal_ie ? `<div>IE: ${user.empresa_fiscal_ie}</div>` : ''}
            <div style="color:var(--text3);font-size:11px">${user.empresa_fiscal_regime || ''} · ${user.empresa_fiscal_uf || ''} · Série NFC-e: ${user.nfce_serie || '001'} · ${user.nfce_ambiente || 'homologacao'}</div>
            ${user.nfce_habilitada ? '<div style="color:var(--green);font-size:11px">✅ NFC-e habilitada no Base44</div>' : '<div style="color:var(--red);font-size:11px">⚠️ NFC-e não habilitada no Base44 (ConfigFiscal)</div>'}
          </div>`;
      } else {
        infoEl.innerHTML = `<span style="color:var(--red);font-size:12px">⚠️ Dados fiscais não encontrados — faça logout e login novamente para recarregar do Base44</span>`;
      }
    }

    const ss = f('cfg-session');
    if (ss && user) {
      const emFiscal = user.empresa_fiscal_nome || user.empresa_nome || '-';
      const emEstoque = user.empresa_estoque_nome || user.empresa_nome || '-';
      const dep = user.deposito_nome || '-';
      ss.innerHTML = `
        <div style="display:grid;gap:6px">
          <div><span style="color:var(--text3);font-size:11px">OPERADOR</span><br><strong>${user.nome || '-'}</strong> · ${user.cargo || 'PDV'}</div>
          <div><span style="color:var(--text3);font-size:11px">EMPRESA FISCAL (NFC-e / NF-e)</span><br><strong>${emFiscal}</strong>${user.empresa_fiscal_cnpj ? ` <span style="color:var(--text3);font-size:11px">· CNPJ ${user.empresa_fiscal_cnpj}</span>` : ''}</div>
          <div><span style="color:var(--text3);font-size:11px">ESTOQUE / DEPÓSITO</span><br><strong>${emEstoque}</strong> · ${dep}${user.unificar_estoque ? ' <span style="color:var(--accent);font-size:10px">(unificado)</span>' : ''}</div>
        </div>`;
    }
  },

  async salvarIA() {
    const key = document.getElementById('cfg-anthropic-key')?.value.trim();
    if (!key) { Toast.show('Informe a chave API', 'error'); return; }
    await window.pdv.config.set('config.anthropic_key', key);
    Toast.show('Chave IA salva!', 'success');
    this._atualizarBadgeIA(true);
  },

  async testarIA() {
    const btn = document.querySelector('[onclick="Config.testarIA()"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Testando...'; }
    try {
      const r = await window.pdv.ia.fiscal('CIMENTO CP-3 VOTORAM 50KG', 'Material Construção', 'UN');
      Toast.show(`IA OK! NCM sugerido: ${r.ncm}`, 'success');
    } catch(e) {
      Toast.show('Erro: ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Testar IA'; }
    }
  },

  _atualizarBadgeIA(configurado) {
    const el = document.getElementById('cfg-ia-status-badge');
    if (!el) return;
    el.style.display = 'block';
    if (configurado) {
      el.style.background = 'rgba(34,197,94,.15)'; el.style.color = 'var(--green)';
      el.textContent = '✓ IA configurada e pronta para uso';
    } else {
      el.style.background = 'rgba(251,191,36,.1)'; el.style.color = 'var(--orange)';
      el.textContent = '⚠ Chave API não configurada — IA indisponível';
    }
  },

  async salvarFiscal() {
    const token         = document.getElementById('cfg-fiscal-token')?.value.trim();
    const tokenProd     = document.getElementById('cfg-fiscal-token-producao')?.value.trim();
    const ambiente      = document.getElementById('cfg-fiscal-ambiente')?.value;
    await window.pdv.config.set('config.fiscal_token',         token);
    await window.pdv.config.set('config.fiscal_token_producao',tokenProd);
    await window.pdv.config.set('config.fiscal_ambiente',      ambiente);
    Toast.show('Configuração fiscal salva!', 'success');
  },

  async testarFiscal() {
    const token = document.getElementById('cfg-fiscal-token')?.value.trim();
    const cnpj  = document.getElementById('cfg-fiscal-cnpj')?.value.replace(/\D/g, '');
    if (!token || !cnpj) { Toast.show('Informe o token e CNPJ antes de testar', 'warning'); return; }
    // Emitir NFC-e mínima de teste (homologação)
    const vendaTeste = {
      numero: 'TESTE-' + Date.now(),
      id: 'teste',
      total: 1.00,
      desconto: 0,
      troco: 0,
      forma_pagamento: 'dinheiro',
      itens: [{
        produto_sku: 'TESTE',
        produto_nome: 'PRODUTO TESTE',
        ncm: '00000000',
        cfop: '5102',
        unidade: 'UN',
        quantidade: 1,
        preco_unitario: 1.00,
        total: 1.00,
        desconto: 0,
      }],
    };
    try {
      const res = await window.pdv.nfce.emitir(vendaTeste);
      if (res.ok || res.aguardando) {
        Toast.show(`✅ FocusNFe conectado! Ref: ${res.reference}`, 'success');
      } else {
        Toast.show(`Erro: ${res.erro}`, 'error', 6000);
      }
    } catch (e) {
      Toast.show('Erro ao conectar FocusNFe: ' + e.message, 'error');
    }
  },

  _setToggle(inputId, spanId, knobId, value) {
    const input = document.getElementById(inputId);
    const span  = document.getElementById(spanId);
    const knob  = document.getElementById(knobId);
    if (!input) return;
    input.checked = value;
    if (span) span.style.background = value ? 'var(--accent)' : 'var(--bg3)';
    if (knob) knob.style.transform = value ? 'translateX(20px)' : 'translateX(0)';
    if (knob) knob.style.background = value ? '#fff' : 'var(--text3)';
  },

  async salvar() {
    await window.pdv.config.set('config.app_id', document.getElementById('cfg-appid')?.value.trim() || '');
    await window.pdv.config.set('config.terminal_id', document.getElementById('cfg-terminal')?.value.trim() || 'PDV-001');
    const estoqueNeg = document.getElementById('cfg-estoque-negativo')?.checked || false;
    const exigirVend = document.getElementById('cfg-exigir-vendedor')?.checked !== false;
    await window.pdv.config.set('config.vender_estoque_negativo', estoqueNeg);
    await window.pdv.config.set('config.exigir_vendedor', exigirVend);
    Toast.show('Configurações salvas!', 'success');
  },

  async setTema(tema) {
    await Theme.apply(tema);
    this._marcarTema(tema);
    Toast.show(`Tema ${tema === 'light' ? 'Claro' : 'Escuro'} ativado`, 'success');
  },

  _marcarTema(tema) {
    const accent = 'var(--accent)';
    const accentBg = 'var(--accent-bg)';
    const normal = 'var(--border2)';
    const normalBg = 'var(--bg3)';
    ['dark', 'light'].forEach(t => {
      const btn = document.getElementById(`cfg-tema-${t}`);
      if (!btn) return;
      const ativo = t === tema;
      btn.style.borderColor = ativo ? accent : normal;
      btn.style.background = ativo ? accentBg : normalBg;
    });
  },

  async _onPrintServerToggle(ativo) {
    this._setToggle('cfg-print-server', 'cfg-toggle-print', 'cfg-toggle-print-knob', ativo);
    document.getElementById('cfg-print-server-section').style.display = ativo ? '' : 'none';
    document.getElementById('cfg-print-client-section').style.display = ativo ? 'none' : '';
    const ts = document.getElementById('cfg-tunnel-section');
    if (ts) ts.style.display = ativo ? '' : 'none';
    if (ativo) {
      await this.carregarImpressoras();
      const status = await window.pdv.print.serverStatus();
      const el = document.getElementById('cfg-print-status');
      if (el) el.textContent = status.rodando ? '🟢 Servidor já está ativo' : '⭕ Servidor inativo — salve para ativar';
    }
  },

  async carregarImpressoras() {
    const lista = await window.pdv.print.listar();
    const sel = document.getElementById('cfg-impressora');
    if (!sel) return;
    const salva = await window.pdv.config.get('config.impressora_nome') || '';
    sel.innerHTML = `<option value="">-- Impressora padrão do sistema --</option>` +
      lista.map(p => `<option value="${p.name}" ${p.name === salva ? 'selected' : ''}>${p.name}${p.padrao ? ' (padrão)' : ''}</option>`).join('');
  },

  async salvarImpressao() {
    const ativo = document.getElementById('cfg-print-server')?.checked || false;
    const porta = parseInt(document.getElementById('cfg-print-porta')?.value || '3001', 10);
    const ip    = document.getElementById('cfg-print-ip')?.value.trim() || '';
    const impressora = document.getElementById('cfg-impressora')?.value || '';
    const auto  = document.getElementById('cfg-print-auto')?.checked || false;
    const layout = document.getElementById('cfg-cupom-layout')?.value || 'padrao';

    await window.pdv.config.set('config.print_server_ativo', ativo);
    await window.pdv.config.set('config.print_server_porta', porta);
    await window.pdv.config.set('config.print_server_ip', ip);
    await window.pdv.config.set('config.impressora_nome', impressora);
    await window.pdv.config.set('config.imprimir_automatico', auto);
    await window.pdv.config.set('config.cupom_layout', layout);

    if (ativo) {
      const res = await window.pdv.print.serverStart(porta);
      const el = document.getElementById('cfg-print-status');
      if (el) el.textContent = res.ok ? `🟢 Servidor ativo na porta ${porta}` : '❌ Falha ao iniciar servidor';
    } else {
      await window.pdv.print.serverStop();
    }
    Toast.show('Configuração de impressão salva!', 'success');
  },

  _atualizarUiTunnel(status) {
    const led = document.getElementById('tunnel-led');
    const msg = document.getElementById('tunnel-msg');
    const urlBox = document.getElementById('tunnel-url-box');
    const urlInput = document.getElementById('tunnel-url-display');
    const btnStart = document.getElementById('btn-tunnel-start');
    const btnStop  = document.getElementById('btn-tunnel-stop');
    if (!led) return;
    const ativo = status.estado === 'ativo' || status.ativo;
    led.style.background = ativo ? 'var(--green)' : status.estado === 'erro' ? 'var(--red)' : status.estado === 'aguardando' || status.estado === 'iniciando' || status.estado === 'baixando' ? '#f59e0b' : 'var(--text3)';
    msg.textContent = status.mensagem || (ativo ? `Tunnel ativo: ${status.url}` : 'Tunnel inativo');
    if ((ativo || status.url) && status.url) {
      urlBox.style.display = 'block';
      urlInput.value = status.url;
    } else {
      urlBox.style.display = 'none';
    }
    if (btnStart) btnStart.style.display = ativo ? 'none' : '';
    if (btnStop)  btnStop.style.display  = ativo ? '' : 'none';
  },

  async iniciarTunnel() {
    const porta = parseInt(document.getElementById('cfg-print-porta')?.value || '3001');
    this._atualizarUiTunnel({ estado: 'aguardando', mensagem: 'Iniciando tunnel Cloudflare...' });
    window.pdv.tunnel.onStatus((s) => this._atualizarUiTunnel(s));
    try {
      const res = await window.pdv.tunnel.start(porta);
      this._atualizarUiTunnel({ estado: 'ativo', url: res.url, mensagem: `Tunnel ativo: ${res.url}` });
    } catch (e) {
      this._atualizarUiTunnel({ estado: 'erro', mensagem: 'Erro: ' + e.message });
    }
  },

  async pararTunnel() {
    await window.pdv.tunnel.stop();
    this._atualizarUiTunnel({ estado: 'parado', mensagem: 'Tunnel encerrado' });
  },

  copiarTunnelUrl() {
    const url = document.getElementById('tunnel-url-display')?.value;
    if (url) { navigator.clipboard.writeText(url); Toast.show('URL copiada!', 'success'); }
  },

  async testarConexaoImpressao() {
    const ip = document.getElementById('cfg-print-ip')?.value.trim();
    if (!ip) { Toast.show('Informe o IP ou URL do servidor', 'warning'); return; }
    try {
      // Ping via main process (evita bloqueio CSP para URLs externas)
      const res = await window.pdv.print.ping(ip);
      if (res.ok) {
        Toast.show(`✅ Conectado ao servidor de impressão`, 'success');
      } else {
        Toast.show(`Servidor respondeu com erro ${res.status || res.erro}`, 'error');
      }
    } catch (e) {
      Toast.show(`Falha ao conectar: ${e.message}`, 'error');
    }
  },

  async syncPendentes() {
    const pend = await window.pdv.sync.pendentes();
    Modal.open(`
<div style="max-height:300px;overflow-y:auto">
  ${pend.length === 0
    ? '<div class="empty-state"><div class="icon">✅</div><h3>Nenhuma operação pendente</h3></div>'
    : pend.map(p => `
    <div style="padding:8px 0;border-bottom:1px solid var(--border);font-size:12px">
      <span class="badge badge-yellow">${p.entidade}</span>
      <span style="margin-left:8px;color:var(--text2)">${p.operacao} · ${new Date(p.created_at).toLocaleString('pt-BR')}</span>
      ${p.erro ? `<div style="color:var(--red);font-size:11px;margin-top:2px">❌ ${p.erro}</div>` : ''}
    </div>`).join('')}
</div>
<div class="modal-actions"><button class="btn btn-ghost" onclick="Modal.close()">Fechar</button></div>
`, `${pend.length} Operações Pendentes`);
  }
};

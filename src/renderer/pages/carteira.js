// ─── Carteira de Clientes ─────────────────────────────────────────
const Carteira = (() => {
  let _dados = [];
  let _query = '';
  let _ordenacao = 'maior_valor'; // maior_valor | nome | atraso | pendentes
  let _filtroSaldo = 'a_receber';  // a_receber | zerado | todos

  const fmt = (v) => Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function diasAtraso(dataStr) {
    if (!dataStr) return 0;
    const d = Math.floor((Date.now() - new Date(dataStr).getTime()) / 86400000);
    return Math.max(0, d);
  }

  function statusCliente(cliente) {
    if (!cliente.limite_credito || cliente.limite_credito === 0) return 'Liberado';
    const pct = (cliente.total_a_receber / cliente.limite_credito) * 100;
    return pct >= 100 ? 'Bloqueado' : 'Liberado';
  }

  // ─── Render principal ────────────────────────────────────────────
  function render() {
    return `
<div class="page-header">
  <div>
    <div class="page-title">Carteira de Clientes</div>
    <div class="page-subtitle">Acompanhe clientes que compram fiado — crédito, pendências e histórico</div>
  </div>
  <button class="btn btn-ghost btn-sm" onclick="Carteira.sincronizar()">↻ Atualizar</button>
</div>

<!-- Totalizadores -->
<div id="carteira-totais" style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;padding:0 24px 16px"></div>

<!-- Busca + Filtros + Ordenação -->
<div style="display:flex;gap:10px;padding:0 24px 16px;align-items:center;flex-wrap:wrap">
  <input class="input" id="carteira-busca" placeholder="🔍 Buscar cliente..."
    oninput="Carteira.buscar(this.value)"
    style="flex:1;min-width:200px;max-width:360px">
  <div id="carteira-filtro-saldo" style="display:flex;background:var(--bg3);border-radius:8px;padding:3px;gap:2px">
    <button onclick="Carteira.filtrarSaldo('a_receber')" id="btn-filtro-a_receber"
      style="padding:5px 14px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;
             background:var(--accent);color:#fff;transition:all .15s">
      💰 A Receber
    </button>
    <button onclick="Carteira.filtrarSaldo('zerado')" id="btn-filtro-zerado"
      style="padding:5px 14px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;
             background:transparent;color:var(--text2);transition:all .15s">
      ✅ Zerado
    </button>
    <button onclick="Carteira.filtrarSaldo('todos')" id="btn-filtro-todos"
      style="padding:5px 14px;border-radius:6px;border:none;cursor:pointer;font-size:12px;font-weight:600;
             background:transparent;color:var(--text2);transition:all .15s">
      Todos
    </button>
  </div>
  <select class="input" id="carteira-ordem" onchange="Carteira.ordenar(this.value)"
    style="width:190px">
    <option value="maior_valor">↓ Maior valor</option>
    <option value="nome">A–Z Nome</option>
    <option value="atraso">↓ Maior atraso</option>
    <option value="pendentes">↓ Mais pendentes</option>
  </select>
</div>

<!-- Cards de clientes -->
<div id="carteira-lista" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;padding:0 24px 24px;overflow-y:auto;flex:1"></div>
`;
  }

  // ─── Init ────────────────────────────────────────────────────────
  async function init() {
    if (!podePermissao('receber_contas_clientes')) {
      document.getElementById('main-content').innerHTML = `
        <div class="empty-state" style="padding:60px 0">
          <div class="icon">🔒</div>
          <h3>Acesso restrito</h3>
          <p>Você não tem permissão para acessar a Carteira de Clientes.</p>
        </div>`;
      return;
    }
    await _carregarTotais();
    await _carregarLista();
  }

  async function _carregarTotais() {
    const el = document.getElementById('carteira-totais');
    if (!el) return;
    const r = await window.pdv.carteira.resumo();
    el.innerHTML = `
      <div class="card" style="padding:16px">
        <div style="font-size:12px;color:var(--text3);margin-bottom:6px">👥 Clientes na carteira</div>
        <div style="font-size:28px;font-weight:700;font-family:'Syne',sans-serif">${r.total_clientes}</div>
      </div>
      <div class="card" style="padding:16px">
        <div style="font-size:12px;color:var(--text3);margin-bottom:6px">💰 Total a receber</div>
        <div style="font-size:24px;font-weight:700;font-family:'Syne',sans-serif;color:var(--accent)">R$ ${fmt(r.total_a_receber)}</div>
      </div>
      <div class="card" style="padding:16px">
        <div style="font-size:12px;color:var(--text3);margin-bottom:6px">⚠️ Total vencido (+30 dias)</div>
        <div style="font-size:24px;font-weight:700;font-family:'Syne',sans-serif;color:${r.total_vencido > 0 ? 'var(--red)' : 'var(--text2)'}">R$ ${fmt(r.total_vencido)}</div>
      </div>`;
  }

  async function _carregarLista() {
    const el = document.getElementById('carteira-lista');
    if (!el) return;
    el.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text3)">Carregando...</div>`;
    _dados = await window.pdv.carteira.listar(_query);
    _renderLista();
  }

  function _renderLista() {
    const el = document.getElementById('carteira-lista');
    if (!el) return;

    let lista = [..._dados];

    // Filtro por saldo
    if (_filtroSaldo === 'a_receber') lista = lista.filter(c => c.total_a_receber > 0);
    else if (_filtroSaldo === 'zerado') lista = lista.filter(c => c.total_a_receber <= 0);

    if (_ordenacao === 'nome')      lista.sort((a, b) => a.nome.localeCompare(b.nome));
    if (_ordenacao === 'atraso')    lista.sort((a, b) => diasAtraso(b.credito_mais_antigo) - diasAtraso(a.credito_mais_antigo));
    if (_ordenacao === 'pendentes') lista.sort((a, b) => b.pendentes - a.pendentes);
    // maior_valor já vem ordenado do banco

    if (lista.length === 0) {
      el.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1;padding:60px 0">
          <div class="icon">👛</div>
          <h3>Nenhum cliente na carteira</h3>
          <p>Clientes com compras no fiado ou limite de crédito configurado aparecem aqui.</p>
        </div>`;
      return;
    }

    el.innerHTML = lista.map(c => _renderCard(c)).join('');
  }

  function _renderCard(c) {
    const status   = statusCliente(c);
    const pct      = c.limite_credito > 0 ? Math.min(200, Math.round((c.total_a_receber / c.limite_credito) * 100)) : 0;
    const atraso   = diasAtraso(c.credito_mais_antigo);
    const atrasoStr = atraso > 0 ? `<span style="color:${atraso > 30 ? 'var(--red)' : 'var(--yellow)'};font-weight:600">${atraso} dias</span>` : '<span style="color:var(--green)">Em dia</span>';
    const ultimoMov = c.ultimo_movimento ? new Date(c.ultimo_movimento).toLocaleDateString('pt-BR') : '—';
    const badgeColor = status === 'Bloqueado' ? 'var(--red)' : 'var(--green)';
    const barColor   = pct >= 100 ? 'var(--red)' : pct >= 70 ? 'var(--yellow)' : 'var(--accent)';

    return `
<div class="card" style="padding:16px;display:flex;flex-direction:column;gap:12px">
  <!-- Cabeçalho do card -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start">
    <div>
      <div style="font-weight:700;font-size:14px">${c.nome}</div>
      ${c.telefone ? `<div style="font-size:11px;color:var(--text3);margin-top:2px">${c.telefone}</div>` : ''}
      ${c.cpf_cnpj ? `<div style="font-size:11px;color:var(--text3)">${c.cpf_cnpj}</div>` : ''}
    </div>
    <span style="background:${badgeColor}22;color:${badgeColor};border:1px solid ${badgeColor}44;
      font-size:10px;font-weight:600;padding:3px 8px;border-radius:20px;white-space:nowrap">
      ${status === 'Bloqueado' ? '🔴' : '✅'} ${status}
    </span>
  </div>

  <!-- Grid de valores -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
    <!-- A Receber -->
    <div style="background:var(--bg3);border-radius:8px;padding:10px">
      <div style="font-size:10px;color:var(--text3);margin-bottom:4px">💰 A Receber</div>
      <div style="font-size:18px;font-weight:700;color:${c.total_a_receber > 0 ? 'var(--accent)' : 'var(--text2)'}">
        R$ ${fmt(c.total_a_receber)}
      </div>
    </div>
    <!-- Limite -->
    <div style="background:var(--bg3);border-radius:8px;padding:10px">
      <div style="font-size:10px;color:var(--text3);margin-bottom:4px">📊 Limite</div>
      <div style="font-size:18px;font-weight:700">R$ ${fmt(c.limite_credito)}</div>
      ${c.limite_credito > 0 ? `
      <div style="background:var(--bg2);height:4px;border-radius:2px;margin-top:6px;overflow:hidden">
        <div style="background:${barColor};height:100%;width:${Math.min(100,pct)}%;border-radius:2px;transition:width .3s"></div>
      </div>
      <div style="font-size:10px;color:${barColor};margin-top:3px">${pct}% utilizado</div>` : ''}
    </div>
    <!-- Crédito Loja -->
    <div style="background:var(--bg3);border-radius:8px;padding:10px">
      <div style="font-size:10px;color:var(--text3);margin-bottom:4px">🎁 Crédito Loja</div>
      <div style="font-size:15px;font-weight:600;color:${c.saldo_credito > 0 ? 'var(--green)' : 'var(--text2)'}">
        R$ ${fmt(c.saldo_credito)}
      </div>
    </div>
    <!-- Atraso -->
    <div style="background:var(--bg3);border-radius:8px;padding:10px">
      <div style="font-size:10px;color:var(--text3);margin-bottom:4px">⏱ Atraso Máx</div>
      <div style="font-size:13px;font-weight:600">${atrasoStr}</div>
      ${c.credito_mais_antigo ? `<div style="font-size:10px;color:var(--text3);margin-top:2px">${new Date(c.credito_mais_antigo).toLocaleDateString('pt-BR')}</div>` : ''}
    </div>
  </div>

  <!-- Rodapé: último mov + pendentes -->
  <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--text3);padding-top:6px;border-top:1px solid var(--border)">
    <span>Último pgto: <strong>${ultimoMov}</strong></span>
    ${c.pendentes > 0 ? `<span style="display:flex;align-items:center;gap:4px">📋 <strong>${c.pendentes} pendente${c.pendentes > 1 ? 's' : ''}</strong></span>` : '<span style="color:var(--green)">✅ Sem pendências</span>'}
  </div>

  <!-- Ações -->
  <div style="display:flex;gap:8px">
    <button class="btn btn-ghost btn-sm" style="flex:1"
      onclick="Carteira.abrirContas(${JSON.stringify(c).replace(/"/g,'&quot;')})">
      💳 Contas a Receber
    </button>
    ${c.total_a_receber > 0 && podePermissao('receber_contas_clientes') ? `
    <button class="btn btn-primary btn-sm" style="flex:1"
      onclick="Carteira.abrirReceber(${JSON.stringify(c).replace(/"/g,'&quot;')})">
      ✅ Receber
    </button>` : ''}
  </div>
</div>`;
  }

  // ─── Busca e Ordenação ───────────────────────────────────────────
  let _buscaTimer = null;
  function buscar(val) {
    _query = val;
    clearTimeout(_buscaTimer);
    _buscaTimer = setTimeout(() => _carregarLista(), 300);
  }

  function ordenar(val) {
    _ordenacao = val;
    _renderLista();
  }

  function filtrarSaldo(val) {
    _filtroSaldo = val;
    // Atualizar visual dos botões
    ['a_receber', 'zerado', 'todos'].forEach(k => {
      const btn = document.getElementById('btn-filtro-' + k);
      if (!btn) return;
      btn.style.background = k === val ? 'var(--accent)' : 'transparent';
      btn.style.color      = k === val ? '#fff' : 'var(--text2)';
    });
    _renderLista();
  }

  // ─── Modal: Contas a Receber do cliente (fiado) ─────────────────
  async function abrirContas(cliente) {
    const contas = await window.pdv.carteira.contasAbertas(cliente.remote_id);

    const linhas = contas.length === 0
      ? '<div class="empty-state" style="padding:20px 0"><p>Nenhuma conta pendente</p></div>'
      : contas.map(ct => {
          const venc = ct.vencimento ? new Date(ct.vencimento + 'T00:00:00') : null;
          const hoje = new Date();
          const diasVencido = venc ? Math.max(0, Math.floor((hoje - venc) / 86400000)) : 0;
          const vencStr = venc ? venc.toLocaleDateString('pt-BR') : '—';
          return `
          <div style="display:flex;justify-content:space-between;align-items:center;
            padding:10px 0;border-bottom:1px solid var(--border);gap:8px">
            <div style="flex:1">
              <div style="font-size:13px;font-weight:600">${ct.descricao || 'Conta'}</div>
              <div style="font-size:11px;color:var(--text3)">Vencimento: ${vencStr}
                ${diasVencido > 0 ? `<span style="color:${diasVencido > 30 ? 'var(--red)':'var(--yellow)'}"> ⏱ ${diasVencido}d atraso</span>` : ''}
              </div>
              ${ct.observacao ? `<div style="font-size:11px;color:var(--text3)">${ct.observacao}</div>` : ''}
            </div>
            <div style="text-align:right;flex-shrink:0;margin-right:8px">
              <div style="font-weight:700;color:var(--accent)">R$ ${fmt(ct.valor)}</div>
            </div>
            ${podePermissao('receber_contas_clientes') ? `<button class="btn btn-ghost btn-sm" style="flex-shrink:0"
              onclick="Carteira._receberConta('${ct.id}', ${ct.valor}, ${JSON.stringify(cliente).replace(/"/g,'&quot;')})">
              Receber
            </button>` : ''}
          </div>`;
        }).join('');

    const clienteJson = JSON.stringify(cliente).replace(/"/g,'&quot;');
    const contasJson  = JSON.stringify(contas).replace(/"/g,'&quot;');
    Modal.open(`
<div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center">
  <div>
    <div style="font-weight:700">${cliente.nome}</div>
    ${cliente.telefone ? `<div style="font-size:12px;color:var(--text3)">${cliente.telefone}</div>` : ''}
  </div>
  <div style="text-align:right">
    <div style="font-size:11px;color:var(--text3)">Total pendente</div>
    <div style="font-size:20px;font-weight:700;color:var(--accent)">R$ ${fmt(cliente.total_a_receber)}</div>
  </div>
</div>
<div style="max-height:380px;overflow-y:auto">${linhas}</div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">Fechar</button>
  ${contas.length > 0 ? `<button class="btn btn-ghost" style="color:var(--green)" onclick="Carteira.enviarCobrancaWhatsApp(${clienteJson},${contasJson})">📲 Cobrar via WhatsApp</button>` : ''}
  ${contas.length > 0 && podePermissao('receber_contas_clientes') ? `<button class="btn btn-primary" onclick="Carteira.abrirReceber(${clienteJson})">✅ Receber tudo</button>` : ''}
</div>`, `Contas a Receber — ${cliente.nome}`);
  }

  // ─── Modal: Receber pagamento ────────────────────────────────────
  async function abrirReceber(cliente) {
    Modal.open(`
<div style="margin-bottom:14px">
  <div style="font-weight:600;font-size:14px">${cliente.nome}</div>
  <div style="font-size:12px;color:var(--text3)">Total em aberto: R$ ${fmt(cliente.total_a_receber)}</div>
</div>
<div class="form-group">
  <label class="form-label">Valor recebido (R$)</label>
  <input class="input" id="receber-valor" type="number" step="0.01" min="0.01"
    value="${cliente.total_a_receber.toFixed(2)}"
    style="font-size:22px;font-weight:700;text-align:center">
</div>
<div class="form-group">
  <label class="form-label">Forma de pagamento</label>
  <select class="input" id="receber-forma">
    <option value="dinheiro">💵 Dinheiro</option>
    <option value="pix">📱 PIX</option>
    <option value="debito">💳 Débito</option>
    <option value="credito">💳 Crédito</option>
  </select>
</div>
<div class="form-group">
  <label class="form-label">Observação</label>
  <input class="input" id="receber-obs" placeholder="Opcional">
</div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
  <button class="btn btn-primary" onclick="Carteira._confirmarReceber('${cliente.remote_id}', '${cliente.nome.replace(/'/g,"\\'")}')">
    Confirmar recebimento
  </button>
</div>`, `Receber Pagamento`);
    setTimeout(() => {
      const el = document.getElementById('receber-valor');
      if (el) { el.focus(); el.select(); }
    }, 100);
  }

  async function _confirmarReceber(clienteRemoteId, clienteNome) {
    const valor = parseFloat(document.getElementById('receber-valor')?.value || '0');
    const forma = document.getElementById('receber-forma')?.value || 'dinheiro';
    const obs   = document.getElementById('receber-obs')?.value?.trim() || null;

    if (!valor || valor <= 0) { Toast.show('Informe um valor válido', 'warning'); return; }

    try {
      // Busca contas pendentes da mais antiga para mais nova e quita até o valor recebido
      const contas = await window.pdv.carteira.contasAbertas(clienteRemoteId);
      let restante = valor;

      for (const ct of contas) {
        if (restante <= 0) break;
        if (ct.valor <= restante + 0.001) {
          await window.pdv.carteira.pagar(ct.id, forma, obs);
          restante = Math.round((restante - ct.valor) * 100) / 100;
        } else {
          // Valor recebido não cobre esta conta — pagamento parcial
          await window.pdv.carteira.pagarParcial(ct.id, restante, ct.valor, forma, obs);
          restante = 0;
        }
      }

      Modal.close();
      Toast.show(`✅ Recebimento de R$ ${fmt(valor)} de ${clienteNome} confirmado`, 'success');
      await _carregarTotais();
      await _carregarLista();
    } catch (e) {
      Toast.show('Erro ao registrar recebimento: ' + e.message, 'error');
    }
  }

  async function _receberConta(contaId, valor, cliente) {
    // Buscar créditos de loja disponíveis
    const creditos = await window.pdv.creditos.getAbertos(cliente.remote_id);
    const totalCredito = creditos.reduce((s, c) => s + (c.saldo_atual || 0), 0);
    const creditoDisp = Math.round(totalCredito * 100) / 100;

    const blocoCredito = creditoDisp > 0 ? `
<div style="background:var(--bg3);border:1px solid var(--green)44;border-radius:8px;padding:12px;margin-bottom:12px">
  <div style="font-size:11px;color:var(--green);font-weight:700;margin-bottom:6px">🎁 CRÉDITO LOJA DISPONÍVEL</div>
  <div style="display:flex;justify-content:space-between;align-items:center">
    <div>
      <div style="font-size:16px;font-weight:700;color:var(--green)">R$ ${fmt(creditoDisp)}</div>
      <div style="font-size:11px;color:var(--text3)">disponível para abatimento</div>
    </div>
    <button class="btn btn-sm" style="background:var(--green);color:#fff;border:none"
      onclick="Carteira._confirmarUsarCredito('${contaId}', ${valor}, '${creditos[0]?.id}', ${creditos[0]?.saldo_atual || 0})">
      Usar crédito
    </button>
  </div>
</div>` : '';

    Modal.open(`
<div style="margin-bottom:14px">
  <div style="font-weight:700;font-size:15px">${cliente.nome}</div>
  <div style="font-size:12px;color:var(--text3)">Valor original: R$ ${fmt(valor)}</div>
</div>

${blocoCredito}

<div class="form-group">
  <label class="form-label">Valor recebido (R$)</label>
  <input class="input" id="receber-conta-valor" type="number" step="0.01" min="0.01" max="${valor}"
    value="${valor.toFixed(2)}" style="font-size:22px;font-weight:700;text-align:center"
    oninput="Carteira._atualizarBotaoParcial(${valor})">
</div>
<div id="aviso-parcial" style="display:none;background:var(--yellow)22;border:1px solid var(--yellow)44;
  border-radius:6px;padding:8px 12px;font-size:12px;color:var(--yellow);margin-bottom:12px">
  ⚠️ Pagamento parcial — o saldo restante ficará em aberto
</div>
<div class="form-group">
  <label class="form-label">Forma de pagamento</label>
  <select class="input" id="receber-conta-forma">
    <option value="dinheiro">💵 Dinheiro</option>
    <option value="pix">📱 PIX</option>
    <option value="debito">💳 Débito</option>
    <option value="credito">💳 Crédito</option>
  </select>
</div>
<div class="form-group">
  <label class="form-label">Observação</label>
  <input class="input" id="receber-conta-obs" placeholder="Opcional">
</div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
  <button class="btn btn-primary" id="btn-confirmar-conta"
    onclick="Carteira._confirmarContaIndividual('${contaId}', ${valor})">
    Confirmar R$ ${fmt(valor)}
  </button>
</div>`, `Receber conta — ${cliente.nome}`);

    setTimeout(() => {
      const el = document.getElementById('receber-conta-valor');
      if (el) { el.focus(); el.select(); }
    }, 100);
  }

  function _atualizarBotaoParcial(valorTotal) {
    const inp = document.getElementById('receber-conta-valor');
    const btn = document.getElementById('btn-confirmar-conta');
    const aviso = document.getElementById('aviso-parcial');
    if (!inp || !btn) return;
    const v = parseFloat(inp.value) || 0;
    const parcial = v < valorTotal - 0.001;
    btn.textContent = `Confirmar R$ ${fmt(v)}`;
    if (aviso) aviso.style.display = parcial ? 'block' : 'none';
  }

  async function _confirmarContaIndividual(contaId, valorTotal) {
    const valorPago = parseFloat(document.getElementById('receber-conta-valor')?.value || '0');
    const forma = document.getElementById('receber-conta-forma')?.value || 'dinheiro';
    const obs   = document.getElementById('receber-conta-obs')?.value?.trim() || null;

    if (!valorPago || valorPago <= 0) { Toast.show('Informe um valor válido', 'warning'); return; }

    try {
      const parcial = valorPago < valorTotal - 0.001;
      if (parcial) {
        await window.pdv.carteira.pagarParcial(contaId, valorPago, valorTotal, forma, obs);
        Toast.show(`✅ R$ ${fmt(valorPago)} recebido — restam R$ ${fmt(valorTotal - valorPago)}`, 'success');
      } else {
        await window.pdv.carteira.pagar(contaId, forma, obs);
        Toast.show(`✅ R$ ${fmt(valorTotal)} recebido`, 'success');
      }
      Modal.close();
      await _carregarTotais();
      await _carregarLista();
    } catch (e) {
      Toast.show('Erro: ' + e.message, 'error');
    }
  }

  async function _confirmarUsarCredito(contaId, contaValor, creditoId, creditoSaldo) {
    if (!creditoId) { Toast.show('Crédito não encontrado', 'error'); return; }
    const obs = document.getElementById('receber-conta-obs')?.value?.trim() || null;
    try {
      const r = await window.pdv.carteira.usarCredito(contaId, contaValor, creditoId, creditoSaldo, obs);
      if (!r.ok) { Toast.show('Erro: ' + r.erro, 'error'); return; }
      if (r.quitou) {
        Toast.show(`✅ Conta quitada com crédito loja. Crédito restante: R$ ${fmt(r.saldoCreditoRestante)}`, 'success');
      } else {
        Toast.show(`✅ Crédito de R$ ${fmt(creditoSaldo)} aplicado — restam R$ ${fmt(r.valorRestante)} em aberto`, 'success');
      }
      Modal.close();
      await _carregarTotais();
      await _carregarLista();
    } catch (e) {
      Toast.show('Erro: ' + e.message, 'error');
    }
  }

  // ─── Enviar cobrança via WhatsApp ───────────────────────────────
  async function enviarCobrancaWhatsApp(cliente, contas) {
    const tel = cliente.telefone?.replace(/\D/g, '');
    if (!tel) {
      Toast.show('Cliente sem telefone cadastrado', 'warning');
      return;
    }

    const empresaNome = (await window.pdv.config.get('empresa_nome')) || 'Vargas';
    const linhasContas = contas.map(ct => {
      const data = ct.vencimento
        ? new Date(ct.vencimento + 'T00:00:00').toLocaleDateString('pt-BR')
        : ct.criado_em
          ? new Date(ct.criado_em).toLocaleDateString('pt-BR')
          : '—';
      const desc = ct.descricao ? ` (${ct.descricao})` : '';
      return `📅 ${data}${desc} — *R$ ${fmt(ct.valor)}*`;
    }).join('\n');

    const total = contas.reduce((s, c) => s + (c.valor || 0), 0);
    const mensagem = `🏪 *${empresaNome}*\n\nOlá, *${cliente.nome}*! 😊\n\nSeu extrato de contas em aberto:\n\n${linhasContas}\n\n💰 *Total em aberto: R$ ${fmt(total)}*\n\nPara quitar, entre em contato conosco.`;

    try {
      await window.pdv.whatsapp.enviar('mensagem_direta', null, tel, { mensagem_texto: mensagem });
      Toast.show('Cobrança enviada via WhatsApp ✅', 'success');
    } catch (e) {
      Toast.show('Erro ao enviar: ' + e.message, 'error');
    }
  }

  // ─── Sincronizar (força re-sync completo de clientes para pegar ajustes de crédito) ───
  async function sincronizar() {
    Toast.show('Sincronizando clientes...', 'info');
    // Re-sync completo de clientes (ignora updated_date) para garantir que ajustes
    // de crédito feitos no Base44 reflitam mesmo sem alteração no updated_date do Cliente
    await window.pdv.clientes.syncForcar();
    await _carregarTotais();
    await _carregarLista();
    Toast.show('Carteira atualizada', 'success');
  }

  return { render, init, buscar, ordenar, filtrarSaldo, abrirContas, abrirReceber, sincronizar,
           enviarCobrancaWhatsApp,
           _confirmarReceber, _receberConta, _atualizarBotaoParcial,
           _confirmarContaIndividual, _confirmarUsarCredito };
})();

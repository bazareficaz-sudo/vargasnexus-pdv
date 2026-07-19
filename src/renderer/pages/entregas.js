// ─── Entregas ─────────────────────────────────────────────────────
const Entregas = (() => {
  let _lista = [];
  let _filtroStatus = 'todos';

  const STATUS_LABEL = {
    pendente:     { label: 'Pendente',      cor: 'var(--yellow,#f59e0b)' },
    em_separacao: { label: 'Em Separação',  cor: 'var(--accent)' },
    em_rota:      { label: 'Em Rota',       cor: '#6366f1' },
    entregue:     { label: 'Entregue',      cor: 'var(--green)' },
    devolvido:    { label: 'Devolvido',     cor: 'var(--red)' },
    cancelada:    { label: 'Cancelada',     cor: 'var(--text3)' },
  };

  const TURNOS = { qualquer: 'Qualquer horário', manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' };

  function render() {
    return `
<div style="display:flex;flex-direction:column;height:100%;overflow:hidden">

  <!-- Header com filtros -->
  <div style="padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg2)">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div>
        <div class="font-syne" style="font-size:18px;font-weight:700">Entregas</div>
        <div style="font-size:12px;color:var(--text3)" id="ent-resumo">Carregando...</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="Entregas.recarregar()">↻ Atualizar</button>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      ${['todos','pendente','em_separacao','em_rota','entregue','devolvido','cancelada'].map(s => `
        <button class="btn btn-sm ${_filtroStatus === s ? 'btn-primary' : 'btn-ghost'}"
          id="ent-filtro-${s}" onclick="Entregas.filtrar('${s}')">
          ${s === 'todos' ? 'Todas' : (STATUS_LABEL[s]?.label || s)}
        </button>`).join('')}
    </div>
  </div>

  <!-- Lista -->
  <div style="flex:1;overflow-y:auto;padding:16px 20px" id="ent-lista">
    <div class="empty-state"><div class="icon">🚚</div><h3>Carregando entregas...</h3></div>
  </div>
</div>

<style>
.ent-card{
  background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-lg);
  padding:14px 16px;margin-bottom:10px;cursor:pointer;transition:border-color .15s
}
.ent-card:hover{border-color:var(--border2)}
.ent-status-badge{
  display:inline-block;padding:2px 10px;border-radius:20px;font-size:10px;
  font-weight:700;letter-spacing:.5px;text-transform:uppercase
}
</style>`;
  }

  async function init() {
    await recarregar();
  }

  async function recarregar() {
    try {
      _lista = await window.pdv.entregas.listar({});
    } catch (e) {
      _lista = [];
      Toast.show('Erro ao carregar entregas: ' + e.message, 'error');
    }
    renderLista();
  }

  function filtrar(status) {
    _filtroStatus = status;
    // Atualizar botões
    ['todos','pendente','em_separacao','em_rota','entregue','devolvido','cancelada'].forEach(s => {
      const btn = document.getElementById(`ent-filtro-${s}`);
      if (btn) {
        btn.className = `btn btn-sm ${_filtroStatus === s ? 'btn-primary' : 'btn-ghost'}`;
      }
    });
    renderLista();
  }

  function renderLista() {
    const el = document.getElementById('ent-lista');
    const resumo = document.getElementById('ent-resumo');
    if (!el) return;

    const filtradas = _filtroStatus === 'todos'
      ? _lista
      : _lista.filter(e => e.status === _filtroStatus);

    const pendentes = _lista.filter(e => e.status === 'pendente').length;
    const emRota    = _lista.filter(e => e.status === 'em_rota').length;
    if (resumo) resumo.textContent = `${_lista.length} total · ${pendentes} pendente${pendentes !== 1 ? 's' : ''} · ${emRota} em rota`;

    if (!filtradas.length) {
      el.innerHTML = `<div class="empty-state">
        <div class="icon">🚚</div>
        <h3>${_filtroStatus === 'todos' ? 'Nenhuma entrega registrada' : 'Nenhuma entrega com esse status'}</h3>
        <p>As entregas aparecem aqui quando uma venda com entrega é finalizada no PDV</p>
      </div>`;
      return;
    }

    el.innerHTML = filtradas.map(e => {
      const st = STATUS_LABEL[e.status] || { label: e.status, cor: 'var(--text3)' };
      const itens = Array.isArray(e.itens) ? e.itens : (e.itens ? JSON.parse(e.itens) : []);
      const data = e.data_agendada ? new Date(e.data_agendada + 'T12:00:00').toLocaleDateString('pt-BR') : '—';
      const turno = TURNOS[e.turno] || e.turno || '—';
      return `
<div class="ent-card" onclick="Entregas.abrirDetalhe('${e.id}')">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
    <div style="flex:1;min-width:0">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
        <span class="ent-status-badge" style="background:${st.cor}22;color:${st.cor}">${st.label}</span>
        ${e.venda_numero ? `<span style="font-size:11px;color:var(--text3)">Venda #${e.venda_numero}</span>` : ''}
      </div>
      <div style="font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.cliente_nome || '—'}</div>
      <div style="font-size:12px;color:var(--text2);margin-top:2px">
        ${[e.logradouro, e.numero, e.bairro, e.cidade].filter(Boolean).join(', ')}
      </div>
      <div style="font-size:11px;color:var(--text3);margin-top:4px">
        📅 ${data} · ${turno}
        ${itens.length ? ` · ${itens.length} item${itens.length > 1 ? 's' : ''}` : ''}
        · R$ ${fmtMoney(e.valor_total_entrega)}
      </div>
    </div>
    <div style="font-size:20px;flex-shrink:0">🚚</div>
  </div>
</div>`;
    }).join('');
  }

  async function abrirDetalhe(id) {
    const e = await window.pdv.entregas.getById(id);
    if (!e) { Toast.show('Entrega não encontrada', 'error'); return; }
    const itens = Array.isArray(e.itens) ? e.itens : (e.itens ? JSON.parse(e.itens) : []);
    const st = STATUS_LABEL[e.status] || { label: e.status, cor: 'var(--text3)' };
    const data = e.data_agendada ? new Date(e.data_agendada + 'T12:00:00').toLocaleDateString('pt-BR') : '—';

    const statusOpts = ['pendente','em_separacao','em_rota','entregue','devolvido','cancelada'];

    Modal.open(`
<div style="display:flex;flex-direction:column;gap:14px">

  <!-- Status atual + troca -->
  <div style="background:var(--bg3);border-radius:8px;padding:12px">
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Status</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      ${statusOpts.map(s => {
        const sl = STATUS_LABEL[s] || { label: s, cor: 'var(--text3)' };
        return `<button class="btn btn-sm ${e.status === s ? 'btn-primary' : 'btn-ghost'}"
          onclick="Entregas._mudarStatus('${id}','${s}')">${sl.label}</button>`;
      }).join('')}
    </div>
  </div>

  <!-- Cliente + Endereço -->
  <div>
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Cliente</div>
    <div style="font-weight:600">${e.cliente_nome || '—'}</div>
    ${e.cliente_telefone ? `<div style="font-size:12px;color:var(--text2)">${e.cliente_telefone}</div>` : ''}
  </div>

  <div>
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Endereço</div>
    <div style="font-size:13px;line-height:1.6">
      ${e.logradouro || ''}, ${e.numero || ''} ${e.complemento ? '— ' + e.complemento : ''}<br>
      ${e.bairro || ''} — ${e.cidade || ''}/${e.estado || ''}
      ${e.cep ? `<br>CEP: ${e.cep}` : ''}
    </div>
  </div>

  <!-- Data + Turno -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
    <div>
      <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Data Agendada</div>
      <div style="font-weight:600">📅 ${data}</div>
    </div>
    <div>
      <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Turno</div>
      <div style="font-weight:600">${TURNOS[e.turno] || e.turno || '—'}</div>
    </div>
  </div>

  <!-- Itens -->
  ${itens.length ? `
  <div>
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Itens (${itens.length})</div>
    ${itens.map(i => `
    <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">
      <span>${i.produto_nome} × ${i.quantidade}</span>
      <span style="color:var(--accent);font-weight:600">R$ ${fmtMoney(i.subtotal)}</span>
    </div>`).join('')}
    <div style="display:flex;justify-content:space-between;padding:8px 0;font-weight:700">
      <span>Total Entrega</span><span style="color:var(--accent)">R$ ${fmtMoney(e.valor_total_entrega)}</span>
    </div>
  </div>` : ''}

  <!-- Observação -->
  ${e.observacao ? `
  <div>
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Observação</div>
    <div style="font-size:13px;background:var(--bg3);padding:8px 12px;border-radius:6px">${e.observacao}</div>
  </div>` : ''}

  <!-- Logística -->
  <div>
    <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Logística</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div><label style="font-size:11px;color:var(--text3);display:block;margin-bottom:3px">Motorista</label>
        <input class="input" id="ent-motorista" value="${e.motorista_nome || ''}" placeholder="Nome do motorista" style="font-size:12px;padding:6px 10px"></div>
      <div><label style="font-size:11px;color:var(--text3);display:block;margin-bottom:3px">Placa</label>
        <input class="input" id="ent-placa" value="${e.veiculo_placa || ''}" placeholder="ABC1D23" style="font-size:12px;padding:6px 10px"></div>
      <div><label style="font-size:11px;color:var(--text3);display:block;margin-bottom:3px">Transportadora</label>
        <input class="input" id="ent-transportadora" value="${e.transportadora || ''}" placeholder="Nome" style="font-size:12px;padding:6px 10px"></div>
      <div><label style="font-size:11px;color:var(--text3);display:block;margin-bottom:3px">Rastreio</label>
        <input class="input" id="ent-rastreio" value="${e.codigo_rastreio || ''}" placeholder="Código" style="font-size:12px;padding:6px 10px"></div>
    </div>
    <div style="margin-top:8px">
      <label style="font-size:11px;color:var(--text3);display:block;margin-bottom:3px">Obs. Entrega</label>
      <input class="input" id="ent-obs-entrega" value="${e.observacao_entrega || ''}" placeholder="Observações do entregador" style="font-size:12px;padding:6px 10px;width:100%">
    </div>
    <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="Entregas._salvarLogistica('${id}')">💾 Salvar logística</button>
  </div>

</div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">Fechar</button>
  <button class="btn btn-secondary" onclick="Entregas._imprimirEntrega('${id}')">🖨️ Imprimir</button>
</div>`, `Entrega — ${e.cliente_nome || '#' + id.substring(0,6)}`);
  }

  async function _mudarStatus(id, novoStatus) {
    const dados = { status: novoStatus };
    if (novoStatus === 'em_rota') dados.data_saida = new Date().toISOString();
    if (novoStatus === 'entregue') dados.data_entrega = new Date().toISOString();
    await window.pdv.entregas.atualizar(id, dados);
    Toast.show(`Status: ${STATUS_LABEL[novoStatus]?.label || novoStatus}`, 'success');
    Modal.close();
    await recarregar();
  }

  async function _imprimirEntrega(id) {
    const e = await window.pdv.entregas.getById(id);
    if (!e) { Toast.show('Entrega não encontrada', 'error'); return; }
    const itens = Array.isArray(e.itens) ? e.itens : (e.itens ? JSON.parse(e.itens) : []);
    const empresaNome = (await window.pdv.config.get('auth.usuario'))?.empresa_nome || 'VargasNexus PDV';
    const dados = {
      empresa_nome:     empresaNome,
      cliente_nome:     e.cliente_nome || '',
      cliente_telefone: e.cliente_telefone || '',
      cliente_doc:      e.cliente_documento || '',
      cep:              e.cep || '',
      logradouro:       e.logradouro || '',
      numero:           e.numero || '',
      complemento:      e.complemento || '',
      bairro:           e.bairro || '',
      cidade:           e.cidade || '',
      estado:           e.estado || '',
      referencia:       e.referencia || '',
      obs:              e.observacao || '',
      data_entrega:     e.data_agendada || '',
      turno:            e.turno || 'qualquer',
      itens:            itens.map(i => ({ produto_nome: i.produto_nome, quantidade: i.quantidade, total: i.subtotal || i.total || 0 })),
      total_entrega:    e.valor_total_entrega || 0,
      numero_venda:     e.venda_numero || null,
      emitido_em:       new Date().toISOString(),
    };
    try {
      await window.pdv.print.entrega(dados);
      Toast.show('Comprovante enviado para impressão', 'success');
    } catch(err) {
      Toast.show('Erro ao imprimir: ' + err.message, 'error');
    }
  }

  async function _salvarLogistica(id) {
    const dados = {
      motorista_nome:    document.getElementById('ent-motorista')?.value.trim() || null,
      veiculo_placa:     document.getElementById('ent-placa')?.value.trim() || null,
      transportadora:    document.getElementById('ent-transportadora')?.value.trim() || null,
      codigo_rastreio:   document.getElementById('ent-rastreio')?.value.trim() || null,
      observacao_entrega:document.getElementById('ent-obs-entrega')?.value.trim() || null,
    };
    await window.pdv.entregas.atualizar(id, dados);
    Toast.show('Logística salva!', 'success');
    Modal.close();
    await recarregar();
  }

  return { render, init, recarregar, filtrar, abrirDetalhe, _mudarStatus, _salvarLogistica, _imprimirEntrega };
})();

// ─── App Controller ────────────────────────────────────────────────
const App = (() => {
  let currentPage = 'pdv';

  // ─── Init ────────────────────────────────────────────────────
  async function init() {
    // Sempre exigir login ao abrir o PDV
    renderLogin();
    return;
  }

  async function _initApp() {
    setupSyncListener();
    setupUpdateListener();
    await refreshSyncStatus();
    await atualizarBadgeFaltas();
    setInterval(atualizarBadgeFaltas, 60000);
  }

  async function showApp() {
    document.getElementById('login-screen').style.display = 'none';
    const usuario = await window.pdv.config.get('auth.usuario');
    window.PDV_PERMS = usuario?.permissoes || null;
    console.log('[PERMS]', JSON.stringify(window.PDV_PERMS));
    renderNavUser();
    const navCarteira = document.getElementById('nav-carteira');
    if (navCarteira) navCarteira.style.display = podePermissao('receber_contas_clientes') ? 'flex' : 'none';
    _initApp();
    // Mostrar launcher em vez de ir direto para o PDV
    showLauncher();
  }

  function showLauncher() {
    document.getElementById('main-layout').style.display = 'none';
    const el = document.getElementById('launcher-screen');
    el.style.display = 'block';
    Launcher.init();
  }

  async function renderNavUser() {
    const user = await window.pdv.config.get('auth.usuario');
    const el = document.getElementById('nav-user');
    if (el && user) {
      el.innerHTML = `
        ${user.empresa_nome ? `<div style="font-size:10px;color:var(--accent);font-weight:700;letter-spacing:.5px;text-transform:uppercase;margin-bottom:2px;opacity:.85">${user.empresa_nome}</div>` : ''}
        <div class="user-name">${user.nome || 'Operador'}</div>
        <div class="user-role">${user.cargo || 'PDV'} · <span style="cursor:pointer;color:var(--accent)" onclick="App.logout()">Sair</span></div>`;
    }
    const tbEmpresa = document.getElementById('titlebar-empresa');
    if (tbEmpresa && user?.empresa_nome) tbEmpresa.textContent = user.empresa_nome;
    // Versão na titlebar
    const tbVer = document.getElementById('titlebar-version');
    if (tbVer) {
      window.pdv.app.version().then(v => { if (v) tbVer.textContent = `v${v}`; }).catch(() => {});
    }
  }

  // ─── Routing ──────────────────────────────────────────────────
  function navigate(page) {
    currentPage = page;

    // Atualizar nav
    document.querySelectorAll('.nav-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.page === page);
    });

    // Atualizar titlebar
    const titles = {
      pdv: 'Frente de Caixa', clientes: 'Clientes',
      produtos: 'Produtos', vendas: 'Vendas',
      orcamentos: 'Orçamentos',
      estoque: 'Estoque', faltas: 'Faltas & Encomendas',
      carteira: 'Carteira de Clientes', entregas: 'Entregas',
      config: 'Configurações', marketplace: 'Marketplace'
    };
    document.getElementById('titlebar-page').textContent = titles[page] || '';

    // Renderizar página
    const content = document.getElementById('main-content');
    const pages = { pdv: PDV, produtos: Produtos, clientes: Clientes,
                    vendas: Vendas, orcamentos: Orcamentos, estoque: Estoque, faltas: Faltas,
                    carteira: Carteira, entregas: Entregas, config: Config,
                    marketplace: Marketplace };
    const p = pages[page];
    if (p) {
      content.innerHTML = p.render();
      p.init && p.init();
    }
  }

  async function atualizarBadgeFaltas() {
    try {
      const total = await window.pdv.faltas.contarPendentes();
      const badge = document.getElementById('faltas-badge');
      if (badge) {
        badge.style.display = total > 0 ? 'inline-block' : 'none';
        badge.textContent = total;
      }
    } catch {}
  }

  // ─── Update UI ───────────────────────────────────────────────
  function setupUpdateListener() {
    if (!window.pdv.update) return;
    window.pdv.update.onStatus((data) => {
      if (data.evento === 'available') {
        mostrarBannerUpdate(`⬇️ Atualizando para v${data.versao}...`);
      } else if (data.evento === 'downloaded') {
        mostrarBannerUpdate(`✅ v${data.versao} pronto — <a href="#" onclick="window.pdv.update.install();return false" style="color:inherit;font-weight:700;text-decoration:underline">Reiniciar para atualizar</a>`, true);
      } else if (data.evento === 'progress') {
        mostrarBannerUpdate(`⬇️ Baixando atualização... ${data.porcentagem}% (${data.velocidade} KB/s)`);
      }
    });
  }

  function mostrarBannerUpdate(html, permanente = false) {
    let banner = document.getElementById('update-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'update-banner';
      banner.style.cssText = `
        position:fixed;bottom:0;left:0;right:0;z-index:9999;
        background:var(--accent);color:#fff;
        padding:8px 16px;font-size:12px;text-align:center;
        display:flex;align-items:center;justify-content:center;gap:12px;
        box-shadow:0 -2px 8px rgba(0,0,0,.3);
      `;
      document.body.appendChild(banner);
    }
    banner.innerHTML = html + (permanente ? '' : '');
    banner.style.display = 'flex';
  }

  // ─── Sync UI ──────────────────────────────────────────────────
  function setupSyncListener() {
    window.pdv.sync.onUpdate((status) => {
      updateSyncUI(status);
    });
  }

  async function refreshSyncStatus() {
    const status = await window.pdv.sync.status();
    updateSyncUI(status);
  }

  let _syncEraAndamento = false;

  function updateSyncUI(status) {
    const dot = document.getElementById('sync-dot');
    const label = document.getElementById('sync-label');
    const time = document.getElementById('sync-time');
    const btn = document.getElementById('sync-btn');
    const badge = document.getElementById('pending-badge');
    const count = document.getElementById('pending-count');

    if (dot) {
      dot.className = `sync-dot ${status.em_andamento ? 'syncing' : status.online ? 'online' : 'offline'}`;
    }
    if (label) {
      label.textContent = status.em_andamento ? 'Sincronizando...' : status.online ? 'Online' : 'Offline';
    }
    if (time && status.ultima_sync) {
      const d = new Date(status.ultima_sync);
      time.textContent = `Último sync: ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    }
    if (btn) {
      btn.classList.toggle('spinning', status.em_andamento);
    }
    if (badge && count) {
      badge.style.display = (status.pendentes > 0) ? 'flex' : 'none';
      count.textContent = status.pendentes;
    }
    if (status.progresso) {
      if (time) time.textContent = status.progresso;
    }

    // Quando sync termina, recarregar config do SaudeVenda para pegar termômetro atualizado
    if (_syncEraAndamento && !status.em_andamento) {
      if (typeof SaudeVenda !== 'undefined') SaudeVenda.init();
    }
    _syncEraAndamento = status.em_andamento;
  }

  async function syncNow() {
    const btn = document.getElementById('sync-btn');
    if (btn) btn.classList.add('spinning');
    const result = await window.pdv.sync.now();
    if (result.ok) {
      Toast.show('Sincronização concluída!', 'success');
    } else {
      Toast.show(result.msg || 'Sem conexão com o servidor', 'warning');
    }
    await refreshSyncStatus();
  }

  // ─── Login ────────────────────────────────────────────────────
  async function renderLogin() {
    document.getElementById('login-screen').innerHTML = Login.render();
    // Mostrar versão na tela de login
    const ver = await window.pdv.app.version().catch(() => '');
    const el = document.getElementById('login-version');
    const foot = document.getElementById('login-version-footer');
    if (el)   el.textContent   = ver ? `v${ver}` : '';
    if (foot) foot.textContent = ver ? `PDV Vargas v${ver} · Sistema Vargas` : 'PDV Vargas · Sistema Vargas';
    // Pré-preencher terminal ID salvo
    const terminalId = await window.pdv.config.get('config.terminal_id');
    const lt = document.getElementById('l-terminal');
    if (lt && terminalId) lt.value = terminalId;
  }

  async function logout() {
    const ok = await window.pdv.app.confirm('Deseja realmente sair?');
    if (!ok) return;
    await window.pdv.auth.logout();
    location.reload();
  }

  return { init, navigate, syncNow, showApp, showLauncher, renderLogin, logout, atualizarBadgeFaltas };
})();

// ─── Toast ────────────────────────────────────────────────────────
const Toast = {
  show(msg, type = 'success', duration = 3000) {
    const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${icons[type] || '•'}</span><span>${msg}</span>`;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 300); }, duration);
  }
};

// ─── Modal ────────────────────────────────────────────────────────
const Modal = {
  open(html, title = '', subtitle = '') {
    const overlay = document.getElementById('modal-overlay');
    const container = document.getElementById('modal-container');
    container.innerHTML = `
      <div class="modal">
        ${title ? `<div class="modal-title">${title}</div>` : ''}
        ${subtitle ? `<div class="modal-sub">${subtitle}</div>` : ''}
        ${html}
      </div>`;
    overlay.classList.add('open');
    // Tirar foco de qualquer input externo para atalhos de teclado funcionarem no modal
    if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  },
  close() {
    document.getElementById('modal-overlay').classList.remove('open');
    // Limpar conteúdo para evitar que elementos como modal-vendedor-codigo
    // permaneçam no DOM e disparem atalhos de teclado indevidamente
    setTimeout(() => {
      if (!document.getElementById('modal-overlay').classList.contains('open')) {
        document.getElementById('modal-container').innerHTML = '';
      }
    }, 200);
  },
  closeOnBackdrop(e) {
    if (e.target === document.getElementById('modal-overlay')) this.close();
  }
};

// ─── Formatação ───────────────────────────────────────────────────
function fmtMoney(v) {
  return (v || 0).toFixed(2).replace('.', ',');
}

function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// ─── Tema ─────────────────────────────────────────────────────────
const Theme = {
  async apply(tema) {
    document.documentElement.setAttribute('data-theme', tema || 'dark');
    await window.pdv.config.set('config.tema', tema || 'dark');
  },
  async load() {
    const tema = await window.pdv.config.get('config.tema') || 'dark';
    document.documentElement.setAttribute('data-theme', tema);
  }
};

// ─── Permissões ───────────────────────────────────────────────────────
// null = offline/admin = tudo liberado
window.PDV_PERMS = null;
function podePermissao(key) {
  if (window.PDV_PERMS === null) return true;
  if (window.PDV_PERMS[key] === true) return true;
  // Aliases entre nomes usados no código e nomes configurados no Base44
  const aliases = {
    editar_venda:  ['editar_pedido'],
    editar_pedido: ['editar_venda'],
  };
  return (aliases[key] || []).some(alt => window.PDV_PERMS[alt] === true);
}

// Alias global para compatibilidade com Faltas e outros módulos
function appToast(msg, type) { Toast.show(msg, type); }
App.toast = appToast;

// ─── Inicializar ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await Theme.load();
  App.init();
});

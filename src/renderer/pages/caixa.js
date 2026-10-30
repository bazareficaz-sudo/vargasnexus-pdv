// ─── Caixa ────────────────────────────────────────────────────────
//
// A gaveta, na tela de quem trabalha nela. O que esta tela existe para acabar:
// o café, o vale e a compra avulsa saem da gaveta durante o turno, e até agora
// não havia onde registrar — então cada um deles virava "falta no fechamento",
// e o sistema acusava o balconista por dinheiro que o dono mandou pagar.
//
// SÓ ONLINE, e a tela diz isso em vez de fingir. Sem conexão não há fila nem
// retentativa: o fechamento compara o contado com o ledger VIVO e a diferença
// vira lançamento, então operar sobre uma cópia velha gravaria falta ou sobra
// que ninguém perdeu. A frase do aviso tem duas metades de propósito — "o caixa
// precisa de internet" E "as vendas continuam normais" —, porque sem a segunda
// o operador acha que o PDV caiu inteiro.
//
// NENHUMA CONTA DE DINHEIRO AQUI. A tela coleta números e mostra o que o
// servidor respondeu. O esperado, a diferença, a natureza do movimento e o que
// vai para a tesouraria são todos do banco. Se esta tela calculasse qualquer
// um deles, haveria duas respostas para a mesma pergunta.
const Caixa = (() => {
  let _estado = null;
  // O id da TENTATIVA, não do clique. É ele que dá a idempotência: reenviar
  // depois de uma rede ruim devolve "já estava registrada" em vez de tirar o
  // dinheiro duas vezes. Sorteado ao abrir o formulário e mantido até dar certo.
  let _idTentativa = null;
  let _enviando = false;

  const fmt = (v) => Number(v || 0).toLocaleString('pt-BR',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function uuid() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
  }

  /** Centavos a partir do que foi digitado. Aceita vírgula, que é como se digita. */
  function valorDigitado(id) {
    const el = document.getElementById(id);
    if (!el) return NaN;
    const texto = String(el.value || '').trim().replace(/\./g, '').replace(',', '.');
    return texto === '' ? NaN : Number(texto);
  }

  // ─── Render principal ──────────────────────────────────────────
  function render() {
    return `
<div class="page-header">
  <div>
    <div class="page-title">Caixa</div>
    <div class="page-subtitle">Abrir a gaveta, registrar o dinheiro que sai e fechar conferindo</div>
  </div>
  <button class="btn btn-ghost btn-sm" onclick="Caixa.carregar()">↻ Atualizar</button>
</div>
<div id="caixa-corpo"><div class="empty">Carregando…</div></div>`;
  }

  function init() { carregar(); }

  async function carregar() {
    const corpo = document.getElementById('caixa-corpo');
    if (corpo) corpo.innerHTML = '<div class="empty">Carregando…</div>';
    _estado = await window.pdv.caixa.estado();
    desenhar();
  }

  function desenhar() {
    const corpo = document.getElementById('caixa-corpo');
    if (!corpo) return;

    if (!_estado || !_estado.ok) {
      const offline = _estado && _estado.motivo === 'offline';
      corpo.innerHTML = `
<div class="card" style="padding:24px;text-align:center">
  <div style="font-size:32px;margin-bottom:8px">${offline ? '📴' : '⚠️'}</div>
  <div style="font-weight:600;margin-bottom:6px">${offline ? 'Caixa indisponível agora' : 'Não foi possível abrir o caixa'}</div>
  <div style="color:var(--text3);max-width:520px;margin:0 auto 16px">
    ${(_estado && _estado.erro) || 'Erro desconhecido.'}
  </div>
  <button class="btn btn-ghost btn-sm" onclick="Caixa.carregar()">Tentar de novo</button>
</div>`;
      return;
    }

    const e = _estado;
    const sessao = e.sessao;
    const podeAbrir = e.permissoes && e.permissoes.abrir;
    const podeSaida = e.permissoes && e.permissoes.saida;
    const podeFechar = e.permissoes && e.permissoes.fechar;

    // O saldo some quando a loja fecha às cegas e há sessão aberta: quem decide
    // isso é o servidor, e a tela só obedece. Ver `esperadoParaMostrar`.
    const saldo = e.saldoEscondido
      ? '<span style="color:var(--text3)">oculto até a contagem</span>'
      : `R$ ${fmt(e.saldo)}`;

    corpo.innerHTML = `
<div class="card" style="padding:20px;margin-bottom:16px">
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap">
    <div>
      <div style="color:var(--text3);font-size:12px;text-transform:uppercase;letter-spacing:.5px">Gaveta</div>
      <div style="font-size:20px;font-weight:600">${e.gaveta.nome}</div>
      <div style="color:var(--text3);font-size:12px;margin-top:4px">
        ${sessao
          ? `Aberta desde ${new Date(sessao.aberta_em).toLocaleString('pt-BR')} · fundo R$ ${fmt(sessao.fundo_inicial)}`
          : 'Nenhuma sessão aberta'}
      </div>
    </div>
    <div style="text-align:right">
      <div style="color:var(--text3);font-size:12px;text-transform:uppercase;letter-spacing:.5px">Pelo sistema</div>
      <div style="font-size:22px;font-weight:700">${saldo}</div>
    </div>
  </div>

  <div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap">
    ${!sessao && podeAbrir
      ? '<button class="btn btn-primary" onclick="Caixa.formAbrir()">Abrir o caixa</button>' : ''}
    ${sessao && podeSaida
      ? '<button class="btn btn-primary" onclick="Caixa.formSaida()">Registrar saída</button>' : ''}
    ${sessao && podeFechar
      ? '<button class="btn btn-ghost" onclick="Caixa.formFechar()">Fechar o caixa</button>' : ''}
    ${!sessao && podeSaida
      ? '<button class="btn btn-ghost" onclick="Caixa.formSaida()">Registrar saída</button>' : ''}
  </div>

  ${!podeAbrir && !podeSaida && !podeFechar ? `
  <div style="margin-top:16px;color:var(--text3)">
    Você não tem permissão para operar o caixa neste terminal. Fale com o gerente.
  </div>` : ''}
</div>

${!sessao && podeSaida ? `
<div style="color:var(--text3);font-size:12px;padding:0 4px">
  A saída pode ser registrada mesmo com a gaveta fechada — é justamente o
  registro que falta para a loja conseguir começar a abrir.
</div>` : ''}`;
  }

  // ─── Abrir ─────────────────────────────────────────────────────
  function formAbrir() {
    _idTentativa = uuid();
    const saldo = _estado.saldo;
    Modal.open(`
<div class="form-group">
  <label>De onde vem o dinheiro que está na gaveta</label>
  <select class="input" id="caixa-origem" onchange="Caixa._trocarOrigem()">
    <option value="herdado">Já estava na gaveta (o sistema diz R$ ${fmt(saldo)})</option>
    <option value="manual">Estou colocando dinheiro agora</option>
  </select>
</div>
<div class="form-group" id="caixa-fundo-box" style="display:none">
  <label>Quanto está sendo colocado</label>
  <input class="input" id="caixa-fundo" inputmode="decimal" placeholder="0,00">
</div>
<div class="form-group">
  <label>Observação <span id="caixa-obs-exig" style="color:var(--text3)"></span></label>
  <input class="input" id="caixa-abrir-obs" placeholder="De onde veio o dinheiro, quem entregou…">
</div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
  <button class="btn btn-primary" id="caixa-abrir-ok" onclick="Caixa._abrir()">Abrir o caixa</button>
</div>`, 'Abrir o caixa', _estado.gaveta.nome);
  }

  function _trocarOrigem() {
    const origem = document.getElementById('caixa-origem').value;
    const box = document.getElementById('caixa-fundo-box');
    const exig = document.getElementById('caixa-obs-exig');
    if (box) box.style.display = origem === 'manual' ? '' : 'none';
    // Dinheiro entrando sem contraparte exige justificativa escrita, e o banco
    // recusa sem ela. Avisar aqui evita a ida ao servidor só para ouvir isso.
    if (exig) exig.textContent = origem === 'manual' ? '(obrigatória)' : '(opcional)';
  }

  async function _abrir() {
    if (_enviando) return;
    const origem = document.getElementById('caixa-origem').value;
    const obs = (document.getElementById('caixa-abrir-obs').value || '').trim();
    const fundo = origem === 'manual' ? valorDigitado('caixa-fundo') : 0;

    if (origem === 'manual') {
      if (!Number.isFinite(fundo) || fundo <= 0) return Toast.show('Informe quanto está sendo colocado.', 'error');
      if (!obs) return Toast.show('Escreva de onde veio o dinheiro.', 'error');
    }

    await enviar('caixa-abrir-ok', () => window.pdv.caixa.abrir({
      id: _idTentativa, fundoOrigem: origem, fundoInicial: fundo, observacao: obs || null,
    }));
  }

  // ─── Saída ─────────────────────────────────────────────────────
  function formSaida() {
    _idTentativa = uuid();
    const motivos = (_estado.motivos || []).map(
      (m) => `<option value="${m.id}" data-natureza="${m.natureza}">${m.nome}</option>`).join('');

    Modal.open(`
<div class="form-group">
  <label>Quanto saiu da gaveta</label>
  <input class="input" id="caixa-saida-valor" inputmode="decimal" placeholder="0,00" autofocus>
</div>
<div class="form-group">
  <label>Motivo</label>
  <select class="input" id="caixa-saida-motivo" onchange="Caixa._trocarMotivo()">
    <option value="">Escolha…</option>
    ${motivos}
  </select>
</div>
<div class="form-group" id="caixa-benef-box" style="display:none">
  <label>Quem recebeu o dinheiro</label>
  <input class="input" id="caixa-saida-benef" placeholder="Nome de quem pegou">
</div>
<div class="form-group">
  <label>Observação (opcional)</label>
  <input class="input" id="caixa-saida-obs" placeholder="Nota fiscal, detalhe…">
</div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
  <button class="btn btn-primary" id="caixa-saida-ok" onclick="Caixa._saida()">Registrar saída</button>
</div>`, 'Registrar saída de caixa', _estado.gaveta.nome);
  }

  function _trocarMotivo() {
    const sel = document.getElementById('caixa-saida-motivo');
    const opt = sel.options[sel.selectedIndex];
    const box = document.getElementById('caixa-benef-box');
    // Vale sem nome não é registro, é um buraco: "saiu R$ 100 de vale" não
    // responde quem pegou, e é essa a pergunta do fim do mês. Quem decide que
    // um motivo exige nome é o gestor, marcando-o como `vale` no cadastro —
    // não há lista de motivos especiais escrita aqui.
    if (box) box.style.display = (opt && opt.dataset.natureza === 'vale') ? '' : 'none';
  }

  async function _saida() {
    if (_enviando) return;
    const valor = valorDigitado('caixa-saida-valor');
    const motivoId = document.getElementById('caixa-saida-motivo').value;
    const benef = (document.getElementById('caixa-saida-benef') || {}).value || '';
    const obs = (document.getElementById('caixa-saida-obs').value || '').trim();

    if (!Number.isFinite(valor) || valor <= 0) return Toast.show('Informe um valor maior que zero.', 'error');
    if (!motivoId) return Toast.show('Escolha o motivo da saída.', 'error');

    await enviar('caixa-saida-ok', () => window.pdv.caixa.saida({
      id: _idTentativa, valor, tipoDespesaId: motivoId,
      beneficiario: benef.trim() || null, observacao: obs || null,
    }));
  }

  // ─── Fechar ────────────────────────────────────────────────────
  function formFechar() {
    const e = _estado;
    // No modo às cegas o operador conta ANTES de ver. Mostrar o esperado aqui
    // desfaria a escolha da loja — e o servidor, nesse modo, nem manda o número.
    const esperado = e.saldoEscondido
      ? '<div style="color:var(--text3)">Esta loja confere às cegas: conte o dinheiro e informe abaixo.</div>'
      : `<div>O sistema espera <strong>R$ ${fmt(e.saldo)}</strong> na gaveta.</div>`;

    Modal.open(`
<div style="margin-bottom:14px">${esperado}</div>
<div class="form-group">
  <label>Quanto foi contado na gaveta</label>
  <input class="input" id="caixa-contado" inputmode="decimal" placeholder="0,00" autofocus>
</div>
<div class="form-group">
  <label>Quanto fica de troco para amanhã</label>
  <input class="input" id="caixa-troco" inputmode="decimal" placeholder="0,00">
  <div style="color:var(--text3);font-size:12px;margin-top:4px">
    O resto é entregue à tesouraria, e o sistema registra a entrega.
  </div>
</div>
<div class="form-group">
  <label>Observação (opcional)</label>
  <input class="input" id="caixa-fechar-obs" placeholder="Explique uma diferença, se houver…">
</div>
<div class="modal-actions">
  <button class="btn btn-ghost" onclick="Modal.close()">Cancelar</button>
  <button class="btn btn-primary" id="caixa-fechar-ok" onclick="Caixa._fechar()">Fechar o caixa</button>
</div>`, 'Fechar o caixa', _estado.gaveta.nome);
  }

  async function _fechar() {
    if (_enviando) return;
    const contado = valorDigitado('caixa-contado');
    const troco = valorDigitado('caixa-troco');
    const obs = (document.getElementById('caixa-fechar-obs').value || '').trim();

    if (!Number.isFinite(contado) || contado < 0) return Toast.show('Informe quanto foi contado.', 'error');
    const trocoOk = Number.isFinite(troco) ? troco : 0;
    if (trocoOk > contado) return Toast.show('Não dá para deixar mais troco do que o contado.', 'error');

    await enviar('caixa-fechar-ok', () => window.pdv.caixa.fechar({
      sessaoId: _estado.sessao.id,
      valorContado: contado,
      valorMantidoTroco: trocoOk,
      // O número que ESTA tela mostrou, para a trava otimista do banco: se a
      // gaveta andou durante a contagem, o fechamento é recusado em vez de
      // gravar uma diferença que não é real.
      valorEsperadoVisto: _estado.saldoEscondido ? null : _estado.saldo,
      observacao: obs || null,
    }));
  }

  // ─── O envio, que é igual nas três ──────────────────────────────
  //
  // Trava o botão, chama, e trata a resposta. O id da tentativa NÃO é trocado
  // quando dá erro: é justamente aí que ele serve, porque o reenvio precisa ser
  // reconhecido como o mesmo.
  async function enviar(idBotao, acao) {
    const btn = document.getElementById(idBotao);
    _enviando = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }

    let r;
    try { r = await acao(); }
    finally { _enviando = false; }

    if (!r || !r.ok) {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.rotulo || 'Tentar de novo'; }
      Toast.show((r && r.erro) || 'Não foi possível concluir.', 'error');
      // Offline e rota não liberada não são erros de preenchimento: fechar o
      // formulário e mostrar o estado evita o operador insistir num botão que
      // não vai funcionar enquanto a causa não mudar.
      if (r && (r.motivo === 'offline' || r.motivo === 'nao_liberado')) {
        Modal.close();
        _estado = r;
        desenhar();
      }
      return;
    }

    Modal.close();
    Toast.show(r.aviso || 'Pronto.', 'success');
    // A gaveta negativa é um fato, não um erro: significa dinheiro que saiu e
    // nunca foi registrado entrando. O aviso vem do servidor, numa segunda
    // mensagem, para não se misturar com a confirmação.
    if (r.avisoSaldo) setTimeout(() => Toast.show(r.avisoSaldo, 'warning'), 400);
    _idTentativa = null;
    await carregar();
  }

  return {
    render, init, carregar,
    formAbrir, formSaida, formFechar,
    _abrir, _saida, _fechar, _trocarOrigem, _trocarMotivo,
  };
})();

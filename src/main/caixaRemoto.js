/**
 * caixaRemoto.js — a gaveta, pelo terminal.
 *
 * SÓ ONLINE, e isso é desenho e não limitação. O fechamento compara o contado
 * com o ledger VIVO e a diferença vira LANÇAMENTO, não aviso: fechar contra uma
 * cópia velha gravaria falta ou sobra que ninguém perdeu. E uma saída
 * enfileirada seria aplicada depois de um fechamento já feito, mudando
 * retroativamente o esperado de uma sessão fechada.
 *
 * Por isso aqui NÃO existe fila, NÃO existe retentativa automática e NÃO
 * existe caminho legado. Sem rede, a operação responde indisponível e a tela
 * diz isso. VENDER CONTINUA OFFLINE como sempre — nada neste arquivo encosta
 * no caminho da venda.
 *
 * Nenhuma regra de dinheiro vive aqui. Quem decide natureza, idempotência,
 * esperado e diferença é o banco; quem decide a política da loja e quem pode o
 * quê é o servidor. Este arquivo é o telefone.
 */

const crypto = require('crypto');
const Store = require('electron-store');
const terminal = require('./terminal');

const store = new Store();

/**
 * UUID derivado de um texto, estável para sempre.
 *
 * A transferência à tesouraria no fechamento, e o suprimento na abertura com
 * fundo da tesouraria, precisam de um identificador próprio — e ele tem de ser
 * O MESMO numa retentativa, senão o segundo clique transferiria o dinheiro de
 * novo. Derivar do id da operação dá isso de graça: a tela não precisa guardar
 * dois ids, e `transferir_caixa_v1` reconhece o repetido pelo índice único.
 */
function uuidDe(texto) {
  const h = crypto.createHash('sha256').update(String(texto)).digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x40; // versão 4, para ser um UUID bem formado
  b[8] = (b[8] & 0x3f) | 0x80; // variante RFC 4122
  const s = b.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** O operador logado neste terminal, como o servidor vai conferir. */
function operador() {
  const u = store.get('auth.usuario') || {};
  return u.id ? { id: u.id, nome: u.nome || u.login || null, permissoes: u.permissoes || {} } : null;
}

/**
 * A recusa no português do balcão.
 *
 * `rede` é o caso que mais vai acontecer, e a frase precisa dizer as duas
 * coisas que o operador tem de saber: que não deu, e que vender continua
 * funcionando. Sem a segunda metade ele acha que o PDV caiu inteiro.
 */
function traduzir(r) {
  if (r.motivo === 'rede') {
    return {
      ok: false, motivo: 'offline',
      erro: 'O caixa precisa de internet e o terminal está sem conexão agora. '
        + 'As vendas continuam normais; tente o caixa quando a conexão voltar.',
    };
  }
  if (r.motivo === 'sem_identidade') {
    return { ok: false, motivo: 'sem_identidade', erro: 'Este terminal não está ativado.' };
  }
  if (r.motivo === 'rota_desligada') {
    return {
      ok: false, motivo: 'nao_liberado',
      erro: 'O caixa pelo terminal ainda não foi liberado nesta máquina. Fale com o gerente.',
    };
  }
  return { ok: false, motivo: r.motivo || 'recusado', erro: r.erro || 'Não foi possível falar com o servidor.', corpo: r.corpo };
}

/** O estado da gaveta para a tela se desenhar. Leitura, sem efeito. */
async function estado() {
  const op = operador();
  const qs = op ? `?operador_id=${encodeURIComponent(op.id)}` : '';
  const r = await terminal.chamarProtegida(`/api/pdv/caixa${qs}`, null, { metodo: 'GET' });
  if (!r.ok) return traduzir(r);
  return { ok: true, ...r.dados };
}

/**
 * O dinheiro saindo da gaveta.
 *
 * `id` vem da TELA, como na rota do navegador: é ele que dá a idempotência. O
 * clique repetido numa rede ruim devolve "já estava registrada" em vez de tirar
 * o dinheiro duas vezes — e por isso a tela precisa guardar o id da tentativa
 * em vez de sortear um novo a cada envio.
 */
async function registrarSaida(p = {}) {
  const op = operador();
  if (!op) return { ok: false, motivo: 'sem_operador', erro: 'Faça login antes de mexer no caixa.' };
  if (!p.id) return { ok: false, motivo: 'sem_id', erro: 'Tentativa sem identificador.' };

  const r = await terminal.chamarProtegida('/api/pdv/caixa/saida', {
    idempotency_key: `caixa.saida:${p.id}`,
    id: p.id,
    operador_id: op.id,
    valor: Number(p.valor),
    tipo_despesa_id: p.tipoDespesaId || null,
    beneficiario: p.beneficiario || null,
    observacao: p.observacao || null,
  });
  if (!r.ok) return traduzir(r);
  return { ok: true, ...r.dados };
}

/**
 * Abrir a gaveta.
 *
 * O fundo HERDADO não leva valor: quem sabe quanto ficou na gaveta é o ledger,
 * e o servidor lê de lá. Mandar um número daqui só criaria a chance de ele
 * divergir e a abertura ser recusada por um erro de digitação.
 */
async function abrir(p = {}) {
  const op = operador();
  if (!op) return { ok: false, motivo: 'sem_operador', erro: 'Faça login antes de mexer no caixa.' };
  if (!p.id) return { ok: false, motivo: 'sem_id', erro: 'Tentativa sem identificador.' };

  const origem = p.fundoOrigem || 'herdado';
  const r = await terminal.chamarProtegida('/api/pdv/caixa/sessao', {
    idempotency_key: `caixa.abrir:${p.id}`,
    id: p.id,
    operador_id: op.id,
    fundo_origem: origem,
    fundo_inicial: origem === 'herdado' ? undefined : Number(p.fundoInicial || 0),
    observacao: p.observacao || null,
    // Só a origem tesouraria usa, e o banco ignora o resto. Derivado do id da
    // abertura para a retentativa não transferir de novo.
    transferencia_id: origem === 'tesouraria' ? uuidDe(`abertura:${p.id}`) : null,
  });
  if (!r.ok) return traduzir(r);
  return { ok: true, ...r.dados };
}

/**
 * Fechar a gaveta, com a contagem.
 *
 * `valorEsperadoVisto` é o número que a tela MOSTROU, e serve para a trava
 * otimista do banco: se a gaveta foi movimentada enquanto o operador contava, o
 * fechamento é recusado em vez de gravar uma diferença que não é real. Quando a
 * loja fecha às cegas o servidor descarta esse campo — a tela não precisa saber
 * disso, e é melhor que não saiba.
 */
async function fechar(p = {}) {
  const op = operador();
  if (!op) return { ok: false, motivo: 'sem_operador', erro: 'Faça login antes de mexer no caixa.' };
  if (!p.sessaoId) return { ok: false, motivo: 'sem_sessao', erro: 'Nenhuma sessão aberta para fechar.' };

  const r = await terminal.chamarProtegida('/api/pdv/caixa/sessao', {
    idempotency_key: `caixa.fechar:${p.sessaoId}`,
    sessao_id: p.sessaoId,
    operador_id: op.id,
    valor_contado: Number(p.valorContado),
    valor_mantido_troco: Number(p.valorMantidoTroco || 0),
    valor_esperado_visto: p.valorEsperadoVisto == null ? undefined : Number(p.valorEsperadoVisto),
    observacao: p.observacao || null,
    transferencia_id: uuidDe(`fechamento:${p.sessaoId}`),
  }, { metodo: 'PUT' });
  if (!r.ok) return traduzir(r);
  return { ok: true, ...r.dados };
}

module.exports = { estado, registrarSaida, abrir, fechar, uuidDe, traduzir, operador };

/**
 * criar-operador-pdv.js — Cria/atualiza um operador de teste em usuarios_pdv
 * sem mexer nos operadores já existentes.
 *
 * Uso: node scripts/criar-operador-pdv.js <login> <senha> [nome] [empresa_id]
 * Padrão: node scripts/criar-operador-pdv.js teste-nexus 123456
 */

const crypto = require('crypto');
const supabase = require('../src/main/supabaseClient');

const EMPRESA_PADRAO = 'a1000000-0000-0000-0000-000000000001'; // Bazar Eficaz

async function main() {
  const [, , login = 'teste-nexus', senha = '123456', nome = 'Operador Teste', empresaId = EMPRESA_PADRAO] = process.argv;

  const senha_hash = crypto.createHash('sha256').update(senha).digest('hex');

  const { data: empresa } = await supabase.from('empresas').select('id, nome').eq('id', empresaId).single();
  if (!empresa) {
    console.error(`Empresa ${empresaId} não encontrada.`);
    process.exit(1);
  }

  const payload = {
    empresa_id: empresaId,
    empresa_nome: empresa.nome,
    empresa_fiscal_id: empresaId,
    empresa_estoque_id: empresaId,
    login,
    senha_hash,
    nome,
    cargo: 'Operador',
    permissoes: {},
    ativo: true,
  };

  const { data: existente } = await supabase.from('usuarios_pdv').select('id').eq('login', login).maybeSingle();

  const { data, error } = existente
    ? await supabase.from('usuarios_pdv').update(payload).eq('id', existente.id).select().single()
    : await supabase.from('usuarios_pdv').insert(payload).select().single();

  if (error) {
    console.error('Erro ao criar operador:', error.message);
    process.exit(1);
  }

  console.log(`Operador "${login}" pronto. Senha: ${senha}`);
  console.log(data);
}

main();

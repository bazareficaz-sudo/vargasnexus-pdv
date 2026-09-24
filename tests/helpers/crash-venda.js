const fs = require('node:fs');
const path = require('node:path');
const { abrir, syncFalso, ROTA_DESLIGADA } = require('./venda-sync');
const [dir, id, ponto] = process.argv.slice(2);
const db = abrir(dir);
const bruto = db.db();
const prepare = bruto.prepare.bind(bruto);
bruto.prepare = sql => {
  const stmt = prepare(sql);
  const run = stmt.run.bind(stmt);
  stmt.run = (...args) => {
    const binding = sql.includes("SET sync_protocolo = 'negociando_v1'");
    const v1 = sql.includes("SET sync_protocolo = 'v1'");
    const legado = sql.includes("SET sync_protocolo = 'legado'");
    if ((binding && ponto === 'antes_binding') || (legado && ponto === 'antes_legado')) process.exit(77);
    const r = run(...args);
    if ((binding && ponto === 'depois_binding') || (v1 && ponto === 'depois_v1') ||
        (sql.includes('SET remote_id = ?') && ponto === 'depois_synced') ||
        (legado && ponto === 'depois_legado')) process.exit(77);
    return r;
  };
  return stmt;
};
const { sync } = syncFalso(db, { v1: async corpo => {
  if (ponto === 'envio') process.exit(77);
  if (ponto === 'commit_remoto') {
    fs.writeFileSync(path.join(dir, 'servidor-falso.json'), JSON.stringify(corpo));
    process.exit(77);
  }
  if (ponto.includes('legado')) return ROTA_DESLIGADA;
  return { ok: true, dados: { estado: 'aplicada' } };
} });
sync.retentarVendaManual(id).then(() => process.exit(1), e => { console.error(e); process.exit(2); });

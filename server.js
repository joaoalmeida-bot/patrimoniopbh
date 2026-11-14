const express = require('express');
const cookieSession = require('cookie-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const XLSX = require('xlsx');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;

const approved = {
  'joao.almeida': { fullName: 'João Almeida', email: 'joao.almeida@edu.pbh.gov.br' },
  'geliane.maria': { fullName: 'Geliane Maria', email: 'geliane.maria@edu.pbh.gov.br' }
};
const memory = { users: new Map(), assets: [], loans: [] };

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieSession({
  name: 'patrimonio.sid',
  keys: [process.env.SESSION_SECRET || 'dev-only-change-this-secret'],
  httpOnly: true,
  sameSite: 'lax',
  secure: isProduction,
  maxAge: 8 * 60 * 60 * 1000
}));
app.use(express.static('public'));

function clean(value) { return String(value ?? '').trim(); }
function normalizeCode(value) { return clean(value).toLowerCase(); }
function userView(user) { return user ? { username: user.username, fullName: user.full_name || user.fullName, email: user.email } : null; }
function generatedPassword() { return 'pbh' + crypto.randomBytes(5).toString('base64url'); }
function requireAuth(req, res, next) { if (!req.session.user) return res.status(401).json({ ok: false, error: 'Faça login para continuar.' }); next(); }
function csvDate(value) { return value ? new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : ''; }

async function db(query, params = []) {
  if (!pool) throw new Error('DATABASE_NOT_CONFIGURED');
  return pool.query(query, params);
}
async function ensureMemoryUser(username) {
  if (!memory.users.has(username)) memory.users.set(username, { username, ...approved[username], full_name: approved[username].fullName, password_hash: '' });
  return memory.users.get(username);
}
async function lookupUser(username) {
  if (pool) { const r = await db('select * from app_users where username=$1 and active=true', [username]); return r.rows[0]; }
  return memory.users.get(username) || null;
}

app.get('/api/session', (req, res) => res.json({ ok: true, user: userView(req.session.user) }));
app.post('/api/auth/register', async (req, res) => {
  try {
    const email = clean(req.body.email).toLowerCase();
    const entry = Object.entries(approved).find(([, u]) => u.email === email);
    if (!entry) return res.status(400).json({ ok: false, error: 'E-mail não autorizado. Use o e-mail institucional do suporte cadastrado.' });
    const [username, info] = entry;
    const password = generatedPassword();
    const hash = await bcrypt.hash(password, 12);
    if (pool) {
      await db(`insert into app_users (username, full_name, email, password_hash, updated_at)
        values ($1,$2,$3,$4,now()) on conflict (username) do update set password_hash=excluded.password_hash, email=excluded.email, full_name=excluded.full_name, updated_at=now()`, [username, info.fullName, info.email, hash]);
    } else { const u = await ensureMemoryUser(username); Object.assign(u, { password_hash: hash }); }
    res.json({ ok: true, username, fullName: info.fullName, password, message: 'Senha gerada. Copie-a agora; por segurança ela não será exibida novamente.' });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, error: 'Não foi possível gerar a senha.' }); }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const username = clean(req.body.username).toLowerCase();
    const password = clean(req.body.password);
    if (!approved[username] || !password) return res.status(401).json({ ok: false, error: 'Usuário ou senha inválidos.' });
    const user = await lookupUser(username);
    if (!user || !user.password_hash || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ ok: false, error: 'Usuário ou senha inválidos. Se for o primeiro acesso, gere uma senha.' });
    req.session.user = { username: user.username, full_name: user.full_name || user.fullName, email: user.email };
    res.json({ ok: true, user: userView(user) });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, error: 'Falha ao entrar no sistema.' }); }
});
app.post('/api/auth/logout', (req, res) => { req.session = null; res.json({ ok: true }); });

app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    if (pool) {
      const [assets, loans] = await Promise.all([
        db('select id, code, name, category, status from assets order by code'),
        db(`select l.id, l.borrower_name as "borrowerName", l.borrower_email as "borrowerEmail", l.phone,
          l.department, a.code, a.name as "assetName", l.quantity, l.checked_out_at as "checkedOutAt",
          l.expected_return_at as "expectedReturnAt", l.returned_at as "returnedAt", u.username as "authorizedBy",
          u.full_name as "authorizedByName", l.status from loans l join assets a on a.id=l.asset_id join app_users u on u.id=l.authorized_by order by l.created_at desc limit 1000`)
      ]);
      return res.json({ ok: true, assets: assets.rows, loans: loans.rows, user: userView(req.session.user) });
    }
    const assets = memory.assets.map(a => ({ ...a }));
    const loans = memory.loans.slice().reverse().map(l => ({ ...l }));
    res.json({ ok: true, assets, loans, user: userView(req.session.user) });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, error: 'Não foi possível carregar os dados.' }); }
});

app.post('/api/assets', requireAuth, async (req, res) => {
  const code = clean(req.body.code), name = clean(req.body.name), category = clean(req.body.category);
  if (!code || !name) return res.status(400).json({ ok: false, error: 'Informe o número e o nome do equipamento.' });
  try {
    if (pool) { const r = await db('insert into assets (code,name,category) values ($1,$2,$3) returning id,code,name,category,status', [code, name, category]); return res.status(201).json({ ok: true, asset: r.rows[0] }); }
    if (memory.assets.some(a => normalizeCode(a.code) === normalizeCode(code))) return res.status(400).json({ ok: false, error: 'Já existe um equipamento com esse código.' });
    const asset = { id: crypto.randomUUID(), code, name, category, status: 'Disponível' }; memory.assets.push(asset); res.status(201).json({ ok: true, asset });
  } catch (err) { if (err.code === '23505') return res.status(400).json({ ok: false, error: 'Já existe um equipamento com esse código.' }); console.error(err); res.status(500).json({ ok: false, error: 'Não foi possível cadastrar o equipamento.' }); }
});

app.post('/api/loans', requireAuth, async (req, res) => {
  const borrowerName = clean(req.body.borrowerName), borrowerEmail = clean(req.body.borrowerEmail), department = clean(req.body.department), code = clean(req.body.code);
  const phone = clean(req.body.phone) || null, quantity = Math.max(1, Number(req.body.quantity || 1));
  const expected = clean(req.body.expectedReturnAt) || null;
  if (!borrowerName || !borrowerEmail || !department || !code) return res.status(400).json({ ok: false, error: 'Preencha nome, e-mail, setor e patrimônio.' });
  try {
    if (pool) {
      const client = await pool.connect();
      try { await client.query('begin'); const asset = (await client.query('select * from assets where lower(code)=lower($1) for update', [code])).rows[0];
        if (!asset) throw Object.assign(new Error('Equipamento não cadastrado.'), { public: true }); if (asset.status !== 'Disponível') throw Object.assign(new Error('Esse equipamento não está disponível.'), { public: true });
        const row = (await client.query(`insert into loans (borrower_name,borrower_email,phone,department,asset_id,quantity,expected_return_at,authorized_by) values ($1,$2,$3,$4,$5,$6,$7,(select id from app_users where username=$8)) returning id`, [borrowerName, borrowerEmail, phone, department, asset.id, quantity, expected, req.session.user.username])).rows[0];
        await client.query("update assets set status='Emprestado', updated_at=now() where id=$1", [asset.id]); await client.query('commit'); return res.status(201).json({ ok: true, id: row.id });
      } catch (e) { await client.query('rollback'); if (e.public) return res.status(400).json({ ok: false, error: e.message }); throw e; } finally { client.release(); }
    }
    const asset = memory.assets.find(a => normalizeCode(a.code) === normalizeCode(code)); if (!asset) return res.status(400).json({ ok: false, error: 'Equipamento não cadastrado.' }); if (asset.status !== 'Disponível') return res.status(400).json({ ok: false, error: 'Esse equipamento não está disponível.' });
    const loan = { id: crypto.randomUUID(), borrowerName, borrowerEmail, phone, department, code: asset.code, assetName: asset.name, quantity, checkedOutAt: new Date().toISOString(), expectedReturnAt: expected, returnedAt: null, authorizedBy: req.session.user.username, authorizedByName: req.session.user.full_name || req.session.user.fullName, status: 'Em aberto' }; memory.loans.push(loan); asset.status = 'Emprestado'; res.status(201).json({ ok: true, id: loan.id });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, error: 'Não foi possível registrar o empréstimo.' }); }
});

app.post('/api/loans/:id/return', requireAuth, async (req, res) => {
  try {
    if (pool) { const client = await pool.connect(); try { await client.query('begin'); const loan = (await client.query('select * from loans where id=$1 for update', [req.params.id])).rows[0]; if (!loan || loan.status !== 'Em aberto') throw Object.assign(new Error('Empréstimo em aberto não encontrado.'), { public: true }); await client.query("update loans set status='Devolvido', returned_at=now() where id=$1", [loan.id]); await client.query("update assets set status='Disponível', updated_at=now() where id=$1", [loan.asset_id]); await client.query('commit'); return res.json({ ok: true }); } catch (e) { await client.query('rollback'); if (e.public) return res.status(400).json({ ok: false, error: e.message }); throw e; } finally { client.release(); } }
    const loan = memory.loans.find(l => l.id === req.params.id && l.status === 'Em aberto'); if (!loan) return res.status(400).json({ ok: false, error: 'Empréstimo em aberto não encontrado.' }); loan.status = 'Devolvido'; loan.returnedAt = new Date().toISOString(); const a = memory.assets.find(x => normalizeCode(x.code) === normalizeCode(loan.code)); if (a) a.status = 'Disponível'; res.json({ ok: true });
  } catch (err) { console.error(err); res.status(500).json({ ok: false, error: 'Não foi possível registrar a devolução.' }); }
});

app.get('/api/export.xlsx', requireAuth, async (req, res) => {
  try {
    let rows;
    if (pool) rows = (await db(`select l.borrower_name as "Responsável", l.borrower_email as "E-mail", l.phone as "Telefone", l.department as "Setor", a.name as "Equipamento", a.code as "Patrimônio", l.quantity as "Quantidade", l.checked_out_at as "Retirada", l.expected_return_at as "Devolução prevista", l.returned_at as "Devolução", u.username as "Autorizado por", l.status as "Status" from loans l join assets a on a.id=l.asset_id join app_users u on u.id=l.authorized_by order by l.created_at desc`)).rows;
    else rows = memory.loans.slice().reverse().map(l => ({ 'Responsável': l.borrowerName, 'E-mail': l.borrowerEmail, 'Telefone': l.phone || '', 'Setor': l.department, 'Equipamento': l.assetName, 'Patrimônio': l.code, 'Quantidade': l.quantity, 'Retirada': csvDate(l.checkedOutAt), 'Devolução prevista': csvDate(l.expectedReturnAt), 'Devolução': csvDate(l.returnedAt), 'Autorizado por': l.authorizedBy, 'Status': l.status }));
    const book = XLSX.utils.book_new(); const sheet = XLSX.utils.json_to_sheet(rows); XLSX.utils.book_append_sheet(book, sheet, 'Histórico'); const file = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.setHeader('Content-Disposition', 'attachment; filename="patrimonio-pbh-historico.xlsx"'); res.send(file);
  } catch (err) { console.error(err); res.status(500).json({ ok: false, error: 'Não foi possível gerar o Excel.' }); }
});

app.get('*', (req, res) => res.sendFile(require('path').join(process.cwd(), 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`Patrimonio PBH rodando na porta ${PORT}${pool ? ' com PostgreSQL' : ' em modo demonstração'}`));

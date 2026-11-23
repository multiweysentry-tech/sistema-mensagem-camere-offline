// Autenticacao local sem dependencias externas: scrypt + tokens em banco.
const crypto = require('crypto');
const { randomUUID, createHash, scryptSync, timingSafeEqual } = require('crypto');
const { log } = require('./logger');

const COOKIE_NAME = 'sentry_session';
const SESSION_TTL_HOURS = 12;

function hashPassword(password, salt = randomUUID()) {
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, expected] = String(stored || '').split(':');
    if (!salt || !expected) return false;
    const actual = scryptSync(String(password), salt, 64);
    const target = Buffer.from(expected, 'hex');
    return actual.length === target.length && timingSafeEqual(actual, target);
  } catch {
    return false;
  }
}

function hashToken(token) {
  return createHash('sha256').update(String(token || '')).digest('hex');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function extractToken(req) {
  const authorization = String(req.get?.('authorization') || '');
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return parseCookies(req.get?.('cookie'))[COOKIE_NAME] || null;
}

function createAuth({ db } = {}) {
  if (!db) throw new Error('createAuth exige um banco com as funcoes de usuario');

  const publicPaths = new Set(['/api/auth/login', '/api/health']);

  async function resolveUser(token) {
    if (!token) return null;
    const user = await db.getSessionByToken(hashToken(token));
    return user || null;
  }

  async function middleware(req, res, next) {
    try {
      const requestPath = String(req.originalUrl || req.path || '').split('?')[0];
      if (publicPaths.has(requestPath)) return next();
      const user = await resolveUser(extractToken(req));
      if (!user) {
        return res.status(401).json({ codigo: 'UNAUTHORIZED', erro: 'Sessao invalida ou expirada' });
      }
      req.user = { id: user.id, email: user.email, role: user.role, name: user.name };
      req.tenantId = user.tenant_id || 'default';
      return next();
    } catch (error) {
      log('error', 'auth.middleware_failed', { error });
      return res.status(500).json({ codigo: 'AUTH_ERROR', erro: 'Falha na autenticacao' });
    }
  }

  async function socketAuthorize(socket) {
    const token = socket.handshake?.auth?.token || parseCookies(socket.handshake?.headers?.cookie)[COOKIE_NAME];
    const user = await resolveUser(token);
    if (!user) throw new Error('Nao autorizado');
    return { tenantId: user.tenant_id || 'default', user: { id: user.id, email: user.email, role: user.role } };
  }

  function registerRoutes(app) {
    app.post('/api/auth/login', async (req, res) => {
      try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const password = String(req.body?.password || '');
        if (!email || !password) return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Email e senha obrigatorios' });
        const user = await db.getUserByEmail(email);
        if (!user || !verifyPassword(password, user.password_hash)) {
          log('warn', 'auth.login_failed', { email });
          return res.status(401).json({ codigo: 'INVALID_CREDENTIALS', erro: 'Credenciais invalidas' });
        }
        const token = randomUUID() + randomUUID();
        const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600000).toISOString();
        await db.createSessionToken(user.id, hashToken(token), expiresAt);
        res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_HOURS * 3600}`);
        log('info', 'auth.login', { email, tenantId: user.tenant_id });
        return res.json({ ok: true, user: { id: user.id, email: user.email, name: user.name, role: user.role, tenantId: user.tenant_id } });
      } catch (error) {
        log('error', 'auth.login_error', { error });
        return res.status(500).json({ codigo: 'AUTH_ERROR', erro: 'Falha ao entrar' });
      }
    });

    app.post('/api/auth/logout', async (req, res) => {
      const token = extractToken(req);
      if (token) await db.deleteSessionToken(hashToken(token));
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return res.json({ ok: true });
    });

    app.get('/api/auth/me', (req, res) => res.json({ user: req.user || null, required: true }));

    app.post('/api/auth/register', async (req, res) => {
      if (req.user?.role !== 'admin') return res.status(403).json({ codigo: 'FORBIDDEN', erro: 'Somente administradores' });
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) {
        return res.status(400).json({ codigo: 'VALIDATION_ERROR', erro: 'Email valido e senha com pelo menos 10 caracteres' });
      }
      if (await db.getUserByEmail(email)) return res.status(409).json({ codigo: 'CONFLICT', erro: 'Email ja cadastrado' });
      const user = await db.createUser({
        id: randomUUID(),
        tenantId: req.body.tenantId || req.tenantId,
        email,
        name: String(req.body?.name || ''),
        password_hash: hashPassword(password),
        role: req.body?.role === 'viewer' ? 'viewer' : 'admin'
      });
      log('info', 'auth.user_created', { email, tenantId: user.tenant_id });
      return res.status(201).json({ user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenant_id } });
    });

    app.get('/api/auth/users', async (req, res) => {
      if (req.user?.role !== 'admin') return res.status(403).json({ codigo: 'FORBIDDEN', erro: 'Somente administradores' });
      const users = await db.listUsers();
      return res.json(users.filter(user => req.user.role === 'admin' && (user.tenant_id === req.tenantId || req.user.role === 'admin')));
    });
  }

  async function bootstrapAdmin() {
    const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const password = String(process.env.ADMIN_PASSWORD || '');
    if (!email || !password) return false;
    if (await db.getUserByEmail(email)) return false;
    await db.createUser({
      id: randomUUID(),
      tenantId: process.env.ADMIN_TENANT || 'default',
      email,
      name: 'Administrador',
      password_hash: hashPassword(password),
      role: 'admin'
    });
    log('info', 'auth.admin_created', { email, tenantId: process.env.ADMIN_TENANT || 'default' });
    return true;
  }

  return { middleware, registerRoutes, socketAuthorize, bootstrapAdmin, hashPassword, verifyPassword, COOKIE_NAME };
}

module.exports = { createAuth, hashPassword, verifyPassword, hashToken, parseCookies };

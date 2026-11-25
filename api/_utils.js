import crypto from 'node:crypto';
import { getApps, initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function parseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    return parsed;
  }
  if (
    process.env.FIREBASE_PROJECT_ID &&
    process.env.FIREBASE_CLIENT_EMAIL &&
    process.env.FIREBASE_PRIVATE_KEY
  ) {
    return {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }
  return null;
}

export function getFirestoreDb() {
  const sa = parseServiceAccount();
  if (!sa) return null;
  if (!getApps().length) {
    initializeApp({ credential: cert(sa) });
  }
  return getFirestore();
}

export function isFirestoreEnabled() {
  return Boolean(parseServiceAccount());
}

function getMemoryStore(collectionName) {
  if (!globalThis.__GRIT_DB_STORE__) {
    globalThis.__GRIT_DB_STORE__ = new Map();
  }
  if (!globalThis.__GRIT_DB_STORE__.has(collectionName)) {
    globalThis.__GRIT_DB_STORE__.set(collectionName, new Map());
  }
  return globalThis.__GRIT_DB_STORE__.get(collectionName);
}

export async function getDocById(collectionName, docId) {
  if (!docId) return null;
  const id = String(docId);
  const db = getFirestoreDb();
  if (db) {
    const snap = await db.collection(collectionName).doc(id).get();
    return snap.exists ? { id: snap.id, ...snap.data() } : null;
  }
  return getMemoryStore(collectionName).get(id) || null;
}

export async function listDocs(collectionName, filters = {}) {
  const db = getFirestoreDb();
  if (db) {
    let ref = db.collection(collectionName);
    for (const [k, v] of Object.entries(filters)) {
      if (v !== undefined && v !== null && v !== '') {
        ref = ref.where(k, '==', v);
      }
    }
    const snap = await ref.get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
  const all = Array.from(getMemoryStore(collectionName).values());
  return all.filter((item) =>
    Object.entries(filters).every(([k, v]) => v === undefined || v === null || v === '' || item[k] === v)
  );
}

export async function saveDoc(collectionName, docId, data) {
  const id = String(docId);
  const now = new Date().toISOString();
  const db = getFirestoreDb();
  if (db) {
    const ref = db.collection(collectionName).doc(id);
    const existing = await ref.get();
    const payload = {
      ...data,
      id,
      updatedAt: now,
      ...(existing.exists ? {} : { createdAt: now }),
    };
    await ref.set(payload, { merge: true });
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() };
  }
  const store = getMemoryStore(collectionName);
  const prev = store.get(id) || { createdAt: now };
  const next = { ...prev, ...data, id, updatedAt: now };
  store.set(id, next);
  return next;
}

export async function batchSaveDocs(collectionName, items, idField = 'id') {
  const db = getFirestoreDb();
  const now = new Date().toISOString();
  if (db) {
    const chunkSize = 400;
    for (let i = 0; i < items.length; i += chunkSize) {
      const batch = db.batch();
      const slice = items.slice(i, i + chunkSize);
      for (const item of slice) {
        const id = String(item[idField] || crypto.randomUUID());
        const ref = db.collection(collectionName).doc(id);
        batch.set(ref, { ...item, [idField]: id, updatedAt: now }, { merge: true });
      }
      await batch.commit();
    }
    return items.length;
  }
  const store = getMemoryStore(collectionName);
  for (const item of items) {
    const id = String(item[idField] || crypto.randomUUID());
    const prev = store.get(id) || { createdAt: now };
    store.set(id, { ...prev, ...item, [idField]: id, updatedAt: now });
  }
  return items.length;
}

export async function deleteDocById(collectionName, docId) {
  const id = String(docId);
  const db = getFirestoreDb();
  if (db) {
    await db.collection(collectionName).doc(id).delete();
    return true;
  }
  return getMemoryStore(collectionName).delete(id);
}

// Security: Password hashing & HMAC session token
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, storedValue) {
  if (!storedValue) return false;
  if (!storedValue.includes(':')) {
    // Legacy plaintext fallback
    return String(password) === String(storedValue);
  }
  const [salt, key] = storedValue.split(':');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(derived, 'hex'));
}

function getSessionSecret() {
  return process.env.SESSION_SECRET || 'grit-dev-secret-change-in-production';
}

export function signSessionToken(payloadObj) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(
    JSON.stringify({
      ...payloadObj,
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 12, // 12 hours
    })
  ).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function verifySessionToken(token) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', getSessionSecret())
    .update(`${header}.${body}`)
    .digest('base64url');
  if (sig !== expected) return null;
  const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (parsed.exp && parsed.exp < Math.floor(Date.now() / 1000)) return null;
  return parsed;
}

export function requireAuth(req, allowedRoles = []) {
  const authHeader = req.headers?.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const user = verifySessionToken(token);
  if (!user) {
    return { ok: false, status: 401, error: '認証が必要です（再ログインしてください）' };
  }
  if (allowedRoles.length > 0 && !allowedRoles.includes(user.role)) {
    return { ok: false, status: 403, error: 'この操作を行う権限がありません' };
  }
  return { ok: true, user };
}

const LOGIN_ATTEMPTS = new Map();
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export function getRateLimitKey(req, loginId = '') {
  const ip =
    String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() ||
    String(req.headers?.['x-real-ip'] || '').trim() ||
    'unknown_ip';
  return `${ip}:${String(loginId || '').trim().toLowerCase()}`;
}

export function checkLoginRateLimit(key) {
  const entry = LOGIN_ATTEMPTS.get(key);
  if (!entry) return { locked: false, remainingSec: 0 };
  const now = Date.now();
  if (entry.lockUntil && entry.lockUntil > now) {
    return {
      locked: true,
      remainingSec: Math.ceil((entry.lockUntil - now) / 1000),
    };
  }
  if (entry.lockUntil && entry.lockUntil <= now) {
    LOGIN_ATTEMPTS.delete(key);
  }
  return { locked: false, remainingSec: 0 };
}

export function recordLoginFailure(key) {
  const now = Date.now();
  const prev = LOGIN_ATTEMPTS.get(key) || { count: 0, firstAt: now, lockUntil: 0 };
  if (now - prev.firstAt > LOCKOUT_WINDOW_MS) {
    LOGIN_ATTEMPTS.set(key, { count: 1, firstAt: now, lockUntil: 0 });
    return;
  }
  const nextCount = prev.count + 1;
  const lockUntil = nextCount >= MAX_LOGIN_ATTEMPTS ? now + LOCKOUT_WINDOW_MS : 0;
  LOGIN_ATTEMPTS.set(key, {
    count: nextCount,
    firstAt: prev.firstAt,
    lockUntil,
  });
}

export function clearLoginFailures(key) {
  LOGIN_ATTEMPTS.delete(key);
}

export function sendJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.end(JSON.stringify(body));
}

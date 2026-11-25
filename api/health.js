import { isFirestoreEnabled, listDocs, sendJson } from './_utils.js';

export default async function handler(req, res) {
  try {
    const firestore = isFirestoreEnabled();
    const accounts = await listDocs('accounts');
    const templates = await listDocs('monthly_templates');
    return sendJson(res, 200, {
      ok: true,
      storage: firestore ? 'firestore' : 'memory-fallback',
      accountCount: accounts.length,
      templateCount: templates.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return sendJson(res, 500, { ok: false, error: err.message });
  }
}

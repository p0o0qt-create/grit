import {
  getDocById,
  listDocs,
  saveDoc,
  verifyPassword,
  hashPassword,
  signSessionToken,
  isFirestoreEnabled,
  sendJson,
  getRateLimitKey,
  checkLoginRateLimit,
  recordLoginFailure,
  clearLoginFailures,
} from './_utils.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  try {
    const { loginId, password, lineUserId } = req.body || {};

    // Bootstrap default HQ admin if accounts collection is empty
    const existingAccounts = await listDocs('accounts');
    if (existingAccounts.length === 0) {
      await saveDoc('accounts', 'admin', {
        loginId: 'admin',
        name: 'GRIT本部管理者',
        role: 'hq',
        branch: '本部',
        passwordHash: hashPassword('grit2026'),
        mustChangePassword: false,
      });
    }

    let account = null;
    if (lineUserId) {
      const matched = await listDocs('accounts', { lineUserId });
      account = matched[0] || null;
    }
    if (!account && loginId) {
      account = await getDocById('accounts', loginId);
      if (!account) {
        const matched = await listDocs('accounts', { loginId });
        account = matched[0] || null;
      }
    }

    if (!account) {
      return sendJson(res, 401, {
        ok: false,
        error: 'アカウントが見つかりません',
        storage: isFirestoreEnabled() ? 'firestore' : 'memory',
      });
    }

    if (account.status === '承認待ち') {
      return sendJson(res, 403, {
        ok: false,
        error: '現在、本部との相互確認待ちです。相互確認完了後にログイン可能となります。',
      });
    }
    if (account.status === '無効') {
      return sendJson(res, 403, {
        ok: false,
        error: 'このアカウントは無効化されています。本部へお問い合わせください。',
      });
    }

    const rateKey = getRateLimitKey(req, loginId || account.loginId || account.id);
    const rateStatus = checkLoginRateLimit(rateKey);
    if (rateStatus.locked) {
      return sendJson(res, 429, {
        ok: false,
        error: `ログイン試行回数が上限に達しました。${rateStatus.remainingSec}秒後に再試行してください。`,
      });
    }

    if (!password) {
      recordLoginFailure(rateKey);
      return sendJson(res, 401, {
        ok: false,
        error: 'IDまたはパスワードが正しくありません',
      });
    }

    const valid = verifyPassword(password, account.passwordHash || account.password);
    if (!valid) {
      recordLoginFailure(rateKey);
      return sendJson(res, 401, {
        ok: false,
        error: 'IDまたはパスワードが正しくありません',
      });
    }

    clearLoginFailures(rateKey);

    const updated = await saveDoc('accounts', account.id, {
      lastLoginAt: new Date().toISOString(),
    });

    const token = signSessionToken({
      id: updated.id,
      loginId: updated.loginId || updated.id,
      name: updated.name,
      kanjiName: updated.kanjiName || '',
      role: updated.role || 'hq',
      branch: updated.branch || '',
      lineFriendRegistered: Boolean(updated.lineFriendRegistered ?? true),
      linkedStudentName: updated.linkedStudentName || '',
      linkedTeacherName: updated.linkedTeacherName || '',
    });

    const { password: _p, passwordHash: _ph, ...safeAccount } = updated;
    return sendJson(res, 200, {
      ok: true,
      token,
      storage: isFirestoreEnabled() ? 'firestore' : 'memory',
      account: safeAccount,
    });
  } catch (err) {
    console.error('Login error:', err);
    return sendJson(res, 500, { ok: false, error: 'ログイン処理でエラーが発生しました' });
  }
}

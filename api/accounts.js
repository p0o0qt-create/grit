import {
  getDocById,
  listDocs,
  saveDoc,
  deleteDocById,
  hashPassword,
  requireAuth,
  isFirestoreEnabled,
  sendJson,
} from './_utils.js';

const VALID_ROLES = ['hq', 'reception', 'teacher', 'student', 'parent'];

export default async function handler(req, res) {
  const auth = requireAuth(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { ok: false, error: auth.error });
  }

  try {
    if (req.method === 'GET') {
      const docs = await listDocs('accounts');
      const safeList = docs.map((acc) => {
        const { password: _p, passwordHash: _ph, ...safe } = acc;
        return {
          ...safe,
          id: safe.id || safe.loginId,
          loginId: safe.loginId || safe.id,
          role: safe.role || 'hq',
          branch: safe.branch || '',
          name: safe.name || safe.loginId || safe.id,
        };
      });
      return sendJson(res, 200, {
        ok: true,
        storage: isFirestoreEnabled() ? 'firestore' : 'memory',
        accounts: safeList,
      });
    }

    if (req.method === 'POST') {
      const roleCheck = requireAuth(req, ['hq', 'reception']);
      if (!roleCheck.ok) {
        return sendJson(res, roleCheck.status, { ok: false, error: '役職アカウント管理の権限がありません' });
      }

      const { action, payload } = req.body || {};

      if (action === 'CREATE_ACCOUNT' || !action) {
        const acc = payload?.account || req.body || {};
        const loginId = String(acc.loginId || acc.id || '').trim();
        const name = String(acc.name || '').trim();
        const role = String(acc.role || '').trim();
        const branch = String(acc.branch || '').trim();
        const password = String(acc.password || '').trim();
        const lineUserId = String(acc.lineUserId || '').trim();
        const linkedStudentName = String(acc.linkedStudentName || '').trim();
        const linkedTeacherName = String(acc.linkedTeacherName || '').trim();

        if (!loginId) {
          return sendJson(res, 400, { ok: false, error: 'ログインIDを入力してください' });
        }
        if (!name) {
          return sendJson(res, 400, { ok: false, error: '氏名・表示名を入力してください' });
        }
        if (!VALID_ROLES.includes(role)) {
          return sendJson(res, 400, { ok: false, error: '有効な役職を選択してください（hq / reception / teacher / student / parent）' });
        }

        const existing = await getDocById('accounts', loginId);
        if (existing) {
          return sendJson(res, 409, { ok: false, error: `ログインID「${loginId}」は既に登録されています` });
        }

        const docData = {
          id: loginId,
          loginId,
          name,
          role,
          branch,
          lineUserId,
          linkedStudentName,
          linkedTeacherName,
          passwordHash: hashPassword(password || 'grit2026'),
          mustChangePassword: acc.mustChangePassword !== false,
          status: acc.status || '有効',
          createdBy: auth.user.id,
        };

        const saved = await saveDoc('accounts', loginId, docData);
        const { password: _p, passwordHash: _ph, ...safeAccount } = saved;
        return sendJson(res, 200, {
          ok: true,
          account: safeAccount,
        });
      }

      if (action === 'UPDATE_ACCOUNT') {
        const acc = payload?.account || {};
        const targetId = String(acc.id || acc.loginId || '').trim();
        if (!targetId) {
          return sendJson(res, 400, { ok: false, error: '対象アカウントIDが必要です' });
        }
        const current = await getDocById('accounts', targetId);
        if (!current) {
          return sendJson(res, 404, { ok: false, error: '対象アカウントが見つかりません' });
        }

        const nextRole = acc.role && VALID_ROLES.includes(acc.role) ? acc.role : (current.role || 'hq');
        const patch = {
          name: acc.name !== undefined ? String(acc.name).trim() : current.name,
          role: nextRole,
          branch: acc.branch !== undefined ? String(acc.branch).trim() : current.branch,
          lineUserId: acc.lineUserId !== undefined ? String(acc.lineUserId).trim() : (current.lineUserId || ''),
          linkedStudentName: acc.linkedStudentName !== undefined ? String(acc.linkedStudentName).trim() : (current.linkedStudentName || ''),
          linkedTeacherName: acc.linkedTeacherName !== undefined ? String(acc.linkedTeacherName).trim() : (current.linkedTeacherName || ''),
          status: acc.status !== undefined ? String(acc.status).trim() : (current.status || '有効'),
        };
        if (acc.password && String(acc.password).trim()) {
          patch.passwordHash = hashPassword(String(acc.password).trim());
        }

        const saved = await saveDoc('accounts', targetId, patch);
        const { password: _p, passwordHash: _ph, ...safeAccount } = saved;
        return sendJson(res, 200, { ok: true, account: safeAccount });
      }

      if (action === 'DELETE_ACCOUNT') {
        const targetId = String(payload?.accountId || payload?.loginId || '').trim();
        if (!targetId) {
          return sendJson(res, 400, { ok: false, error: '削除するアカウントIDが必要です' });
        }
        if (targetId === 'admin' || targetId === auth.user.id) {
          return sendJson(res, 400, { ok: false, error: '初期管理者（admin）または現在ログイン中のアカウントは削除できません' });
        }
        await deleteDocById('accounts', targetId);
        return sendJson(res, 200, { ok: true, deletedId: targetId });
      }

      return sendJson(res, 400, { ok: false, error: '未対応のactionです' });
    }

    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  } catch (err) {
    console.error('Accounts API error:', err);
    return sendJson(res, 500, { ok: false, error: err.message || 'アカウント処理でエラーが発生しました' });
  }
}

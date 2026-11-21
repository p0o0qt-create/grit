// api/login.js
import { db, timingSafeEqualStr, verifyPasswordHash, signToken } from "./_auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { role, loginId, password, lineUserId } = req.body || {};
    if (!process.env.AUTH_TOKEN_SECRET) {
      return res.status(500).json({ error: "サーバー側の AUTH_TOKEN_SECRET が未設定です" });
    }
    if (!role || !loginId || !password) {
      return res.status(400).json({ error: "ロール・ID・パスワードをすべて入力してください" });
    }

    const cleanRole = String(role).trim();
    const cleanId = String(loginId).trim();
    const cleanLineUserId = lineUserId ? String(lineUserId).trim() : "";

    // 1. Firestore の個別アカウント（本部発行 / 新規登録 / ID・PW変更済み）を検索
    const accountSnap = await db
      .collection("grit_auth_accounts")
      .where("role", "==", cleanRole)
      .where("loginId", "==", cleanId)
      .limit(1)
      .get();

    if (!accountSnap.empty) {
      const docSnap = accountSnap.docs[0];
      const accountData = docSnap.data();

      if (!verifyPasswordHash(password, accountData.salt, accountData.passwordHash)) {
        return res.status(401).json({ error: "IDまたはパスワードが正しくありません" });
      }

      if (accountData.approvalStatus === "pending_hq") {
        return res.status(403).json({
          error: "新規登録は本部許可制です。現在、本部管理者の承認待ちのためログインできません。",
          pendingApproval: true,
        });
      }

      if (accountData.approvalStatus === "rejected") {
        return res.status(403).json({
          error: "この新規登録申請は承認されませんでした。本部までお問い合わせください。",
        });
      }

      if (cleanLineUserId && accountData.lineUserId !== cleanLineUserId) {
        await docSnap.ref.set(
          { lineUserId: cleanLineUserId, updatedAt: new Date().toISOString() },
          { merge: true }
        );
      }

      const mustChange = Boolean(accountData.mustChangeCredentials);
      const effectiveLineUserId = cleanLineUserId || accountData.lineUserId || "";

      const token = signToken({
        docId: docSnap.id,
        role: cleanRole,
        loginId: cleanId,
        displayName: accountData.displayName || cleanId,
        branch: accountData.branch || "",
        isInitial: mustChange,
        isEnvInitial: false,
        exp: Date.now() + 1000 * 60 * 60 * (mustChange ? 1 : 12),
      });

      return res.status(200).json({
        ok: true,
        role: cleanRole,
        loginId: cleanId,
        displayName: accountData.displayName || cleanId,
        branch: accountData.branch || "",
        lineUserId: effectiveLineUserId,
        mustChangeCredentials: mustChange,
        token,
      });
    }

    // 2. 環境変数ベースの初期ID・初期パスワード（初回セットアップ用）を確認
    const roleStatusDoc = await db.collection("grit_auth_role_status").doc(cleanRole).get();
    if (roleStatusDoc.exists && roleStatusDoc.data().initialDisabled === true) {
      return res.status(401).json({ error: "IDまたはパスワードが正しくありません" });
    }

    const initialMap = {
      hq: { id: process.env.INITIAL_HQ_ID, pass: process.env.INITIAL_HQ_PASSWORD },
      staff: { id: process.env.INITIAL_STAFF_ID, pass: process.env.INITIAL_STAFF_PASSWORD },
      teacher: { id: process.env.INITIAL_TEACHER_ID, pass: process.env.INITIAL_TEACHER_PASSWORD },
      guardian: { id: process.env.INITIAL_GUARDIAN_ID, pass: process.env.INITIAL_GUARDIAN_PASSWORD },
      student: { id: process.env.INITIAL_STUDENT_ID, pass: process.env.INITIAL_STUDENT_PASSWORD },
    };

    const initialCred = initialMap[cleanRole];
    if (!initialCred || !initialCred.id || !initialCred.pass) {
      return res.status(401).json({ error: "IDまたはパスワードが正しくありません" });
    }

    if (!timingSafeEqualStr(cleanId, initialCred.id) || !timingSafeEqualStr(password, initialCred.pass)) {
      return res.status(401).json({ error: "IDまたはパスワードが正しくありません" });
    }

    const token = signToken({
      docId: null,
      role: cleanRole,
      loginId: cleanId,
      displayName: cleanId,
      branch: "全校舎",
      isInitial: true,
      isEnvInitial: true,
      exp: Date.now() + 1000 * 60 * 60,
    });

    return res.status(200).json({
      ok: true,
      role: cleanRole,
      loginId: cleanId,
      displayName: cleanId,
      branch: "全校舎",
      lineUserId: cleanLineUserId,
      mustChangeCredentials: true,
      token,
    });
  } catch (err) {
    console.error("Login Error:", err);
    return res.status(500).json({ error: "認証処理中にサーバーエラーが発生しました" });
  }
}

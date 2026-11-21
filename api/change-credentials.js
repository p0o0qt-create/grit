// api/change-credentials.js
import { db, getSessionFromReq, hashPassword, signToken } from "./_auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const session = getSessionFromReq(req);
    if (!session) {
      return res.status(401).json({ error: "セッションが無効です。再度ログインしてください。" });
    }

    const { newLoginId, newPassword, lineUserId } = req.body || {};
    const cleanNewId = String(newLoginId || "").trim();
    const cleanNewPass = String(newPassword || "").trim();
    const cleanLineUserId = lineUserId ? String(lineUserId).trim() : "";

    if (cleanNewId.length < 4) {
      return res.status(400).json({ error: "新しいIDは4文字以上で設定してください。" });
    }
    if (cleanNewPass.length < 8) {
      return res.status(400).json({ error: "新しいパスワードは8文字以上で設定してください。" });
    }
    if (session.isInitial && cleanNewId === session.loginId) {
      return res.status(400).json({ error: "初期IDとは異なる新しいIDを設定してください。" });
    }

    // 同一ロール内でのID重複チェック（自分自身のドキュメントを除く）
    const dupSnap = await db
      .collection("grit_auth_accounts")
      .where("role", "==", session.role)
      .where("loginId", "==", cleanNewId)
      .get();

    const hasOtherDuplicate = dupSnap.docs.some((d) => d.id !== session.docId);
    if (hasOtherDuplicate) {
      return res.status(409).json({ error: "このログインIDはすでに使用されています。" });
    }

    const { salt, passwordHash } = hashPassword(cleanNewPass);
    const batch = db.batch();

    let finalDocId = session.docId;
    let displayName = session.displayName || cleanNewId;
    let branch = session.branch || "";
    let effectiveLineUserId = cleanLineUserId;

    if (session.docId) {
      // Firestore 上の発行済みアカウント（本部発行 / セルフ新規登録 / 既存アカウント）を上書き更新
      const targetRef = db.collection("grit_auth_accounts").doc(session.docId);
      const existingSnap = await targetRef.get();
      if (existingSnap.exists) {
        const prev = existingSnap.data();
        displayName = prev.displayName || displayName;
        branch = prev.branch || branch;
        effectiveLineUserId = cleanLineUserId || prev.lineUserId || "";
      }

      batch.set(
        targetRef,
        {
          role: session.role,
          loginId: cleanNewId,
          salt,
          passwordHash,
          mustChangeCredentials: false,
          initialPasswordDeletedAt: new Date().toISOString(),
          ...(effectiveLineUserId ? { lineUserId: effectiveLineUserId } : {}),
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    } else {
      // 環境変数初期認証（INITIAL_*）からの変更：新アカウントを作成し、環境変数初期認証を無効化
      finalDocId = `${session.role}_${cleanNewId}`;
      const newRef = db.collection("grit_auth_accounts").doc(finalDocId);
      batch.set(newRef, {
        role: session.role,
        loginId: cleanNewId,
        displayName,
        branch,
        salt,
        passwordHash,
        mustChangeCredentials: false,
        ...(effectiveLineUserId ? { lineUserId: effectiveLineUserId } : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      if (session.isEnvInitial) {
        const roleStatusRef = db.collection("grit_auth_role_status").doc(session.role);
        batch.set(
          roleStatusRef,
          {
            initialDisabled: true,
            disabledAt: new Date().toISOString(),
            replacedBy: cleanNewId,
          },
          { merge: true }
        );
      }
    }

    await batch.commit();

    const nextToken = signToken({
      docId: finalDocId,
      role: session.role,
      loginId: cleanNewId,
      displayName,
      branch,
      isInitial: false,
      isEnvInitial: false,
      exp: Date.now() + 1000 * 60 * 60 * 12,
    });

    return res.status(200).json({
      ok: true,
      loginId: cleanNewId,
      displayName,
      branch,
      lineUserId: effectiveLineUserId,
      token: nextToken,
    });
  } catch (err) {
    console.error("Change Credentials Error:", err);
    return res.status(500).json({ error: "ID・パスワード変更中にエラーが発生しました" });
  }
}

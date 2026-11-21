// api/change-credentials.js
import crypto from "crypto";
import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
    }),
  });
}
const db = admin.firestore();

function verifyToken(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");

  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expectedSig, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!data.exp || Date.now() > data.exp) return null;
  return data;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, "sha512").toString("hex");
  return { salt, passwordHash };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const authSecret = process.env.AUTH_TOKEN_SECRET;
    const session = verifyToken(token, authSecret);

    if (!session) {
      return res.status(401).json({ error: "セッションが無効です。再度ログインしてください。" });
    }

    const { newLoginId, newPassword } = req.body || {};
    const cleanNewId = String(newLoginId || "").trim();
    const cleanNewPass = String(newPassword || "").trim();

    if (cleanNewId.length < 4) {
      return res.status(400).json({ error: "新しいIDは4文字以上で設定してください。" });
    }
    if (cleanNewPass.length < 8) {
      return res.status(400).json({ error: "新しいパスワードは8文字以上で設定してください。" });
    }
    if (cleanNewId === session.loginId) {
      return res.status(400).json({ error: "初期IDとは異なる新しいIDを設定してください。" });
    }

    const dupSnap = await db
      .collection("grit_auth_accounts")
      .where("role", "==", session.role)
      .where("loginId", "==", cleanNewId)
      .limit(1)
      .get();

    if (!dupSnap.empty) {
      return res.status(409).json({ error: "このログインIDはすでに使用されています。" });
    }

    const { salt, passwordHash } = hashPassword(cleanNewPass);
    const batch = db.batch();

    // 1. 新しいID・ハッシュ化パスワードを保存
    const newAccountRef = db.collection("grit_auth_accounts").doc(`${session.role}_${cleanNewId}`);
    batch.set(newAccountRef, {
      role: session.role,
      loginId: cleanNewId,
      salt,
      passwordHash,
      updatedAt: new Date().toISOString(),
    });

    // 2. 以前のDB登録アカウント（非初期）からの変更なら旧レコードを削除
    if (!session.isInitial) {
      const oldSnap = await db
        .collection("grit_auth_accounts")
        .where("role", "==", session.role)
        .where("loginId", "==", session.loginId)
        .get();
      oldSnap.forEach((doc) => batch.delete(doc.ref));
    }

    // 3. このロールの初期ID・初期パスワードを完全に無効化（削除扱い）
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

    await batch.commit();

    const nextPayload = Buffer.from(
      JSON.stringify({
        role: session.role,
        loginId: cleanNewId,
        isInitial: false,
        exp: Date.now() + 1000 * 60 * 60 * 12,
      })
    ).toString("base64url");
    const nextSig = crypto.createHmac("sha256", authSecret).update(nextPayload).digest("base64url");

    return res.status(200).json({
      ok: true,
      loginId: cleanNewId,
      token: `${nextPayload}.${nextSig}`,
    });
  } catch (err) {
    console.error("Change Credentials Error:", err);
    return res.status(500).json({ error: "ID・パスワード変更中にエラーが発生しました" });
  }
}

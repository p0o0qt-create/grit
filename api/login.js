// api/login.js
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

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyPasswordHash(password, salt, expectedHash) {
  const derived = crypto.pbkdf2Sync(String(password), salt, 100000, 64, "sha512").toString("hex");
  return timingSafeEqualStr(derived, expectedHash);
}

function signToken(payloadObj, secret) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { role, loginId, password } = req.body || {};
    const authSecret = process.env.AUTH_TOKEN_SECRET;
    if (!authSecret) {
      return res.status(500).json({ error: "サーバー側の AUTH_TOKEN_SECRET が未設定です" });
    }
    if (!role || !loginId || !password) {
      return res.status(400).json({ error: "ロール・ID・パスワードをすべて入力してください" });
    }

    const cleanRole = String(role).trim();
    const cleanId = String(loginId).trim();

    // 1. Firestore に保存された変更済みアカウントを検索
    const accountSnap = await db
      .collection("grit_auth_accounts")
      .where("role", "==", cleanRole)
      .where("loginId", "==", cleanId)
      .limit(1)
      .get();

    if (!accountSnap.empty) {
      const accountData = accountSnap.docs[0].data();
      if (!verifyPasswordHash(password, accountData.salt, accountData.passwordHash)) {
        return res.status(401).json({ error: "IDまたはパスワードが正しくありません" });
      }

      const token = signToken(
        {
          role: cleanRole,
          loginId: cleanId,
          isInitial: false,
          exp: Date.now() + 1000 * 60 * 60 * 12,
        },
        authSecret
      );

      return res.status(200).json({
        ok: true,
        role: cleanRole,
        loginId: cleanId,
        mustChangeCredentials: false,
        token,
      });
    }

    // 2. 変更済みアカウントが見つからない場合、初期ID・初期パスワードがまだ有効か確認
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

    const token = signToken(
      {
        role: cleanRole,
        loginId: cleanId,
        isInitial: true,
        exp: Date.now() + 1000 * 60 * 30,
      },
      authSecret
    );

    return res.status(200).json({
      ok: true,
      role: cleanRole,
      loginId: cleanId,
      mustChangeCredentials: true,
      token,
    });
  } catch (err) {
    console.error("Login Error:", err);
    return res.status(500).json({ error: "認証処理中にサーバーエラーが発生しました" });
  }
}

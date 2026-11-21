// api/login.js
import crypto from "crypto";

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function signToken(payloadObj, secret) {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${sig}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const { role, loginId, password } = req.body || {};
    const authSecret = process.env.AUTH_TOKEN_SECRET;

    const rolePasswordMap = {
      hq: process.env.ADMIN_LOGIN_PASSWORD,
      staff: process.env.STAFF_LOGIN_PASSWORD,
      teacher: process.env.INSTRUCTOR_LOGIN_PASSWORD,
      guardian: process.env.GUARDIAN_LOGIN_PASSWORD,
      student: process.env.STUDENT_LOGIN_PASSWORD,
    };

    const expectedPassword = rolePasswordMap[role];
    if (!authSecret || !expectedPassword) {
      return res.status(500).json({ error: "サーバー側の認証環境変数が未設定です" });
    }

    if (!timingSafeEqualStr(password, expectedPassword)) {
      return res.status(401).json({ error: "IDまたはパスワードが正しくありません" });
    }

    const token = signToken(
      {
        role,
        loginId: loginId || "",
        exp: Date.now() + 1000 * 60 * 60 * 12,
      },
      authSecret
    );

    return res.status(200).json({ ok: true, role, token });
  } catch (err) {
    return res.status(500).json({ error: "認証処理中にサーバーエラーが発生しました" });
  }
}
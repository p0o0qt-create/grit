// api/issue-account.js
import crypto from "crypto";
import { db, getSessionFromReq, hashPassword, generateTempPassword } from "./_auth.js";

const ALLOWED_ROLES = ["hq", "staff", "teacher", "guardian", "student"];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const {
      mode, // "hq_issue" | "self_register"
      role,
      displayName,
      branch,
      grade,
      guardianName,
      desiredLoginId,
      lineUserId,
    } = req.body || {};

    const cleanRole = String(role || "").trim();
    const cleanName = String(displayName || "").trim();
    const cleanBranch = String(branch || "渋谷本校").trim();

    if (!ALLOWED_ROLES.includes(cleanRole)) {
      return res.status(400).json({ error: "無効な役職が指定されました" });
    }
    if (!cleanName) {
      return res.status(400).json({ error: "氏名を入力してください" });
    }

    // 本部発行モードの場合はHQ権限チェック
    let issuedBy = "self_register";
    if (mode !== "self_register") {
      const session = getSessionFromReq(req);
      if (!session || session.role !== "hq") {
        return res.status(403).json({ error: "初期ID・初期パスワードの発行権限がありません（本部管理者専用）" });
      }
      issuedBy = session.loginId;
    } else {
      // 初期画面からのセルフ新規登録は保護者・生徒・講師など公開対象ロールに限定（HQ直接登録は不可）
      if (cleanRole === "hq") {
        return res.status(403).json({ error: "本部管理者アカウントはセルフ登録できません" });
      }
    }

    // 初期IDの決定（指定があれば重複チェック、未指定なら自動採番）
    let initialLoginId = String(desiredLoginId || "").trim();
    if (!initialLoginId) {
      const prefixMap = {
        hq: "hq",
        staff: "staff",
        teacher: "tch",
        guardian: "prt",
        student: "st",
      };
      const suffix = crypto.randomBytes(3).toString("hex");
      initialLoginId = `${prefixMap[cleanRole]}_${suffix}`;
    }

    if (initialLoginId.length < 4) {
      return res.status(400).json({ error: "初期IDは4文字以上で指定してください" });
    }

    const dupSnap = await db
      .collection("grit_auth_accounts")
      .where("role", "==", cleanRole)
      .where("loginId", "==", initialLoginId)
      .limit(1)
      .get();

    if (!dupSnap.empty) {
      return res.status(409).json({ error: "このログインIDはすでに使用されています" });
    }

    const initialPassword = generateTempPassword(10);
    const { salt, passwordHash } = hashPassword(initialPassword);
    const docId = `${cleanRole}_${Date.now()}_${crypto.randomBytes(2).toString("hex")}`;

    const isSelfReg = mode === "self_register";
    const approvalStatus = isSelfReg ? "pending_hq" : "approved";

    await db.collection("grit_auth_accounts").doc(docId).set({
      role: cleanRole,
      loginId: initialLoginId,
      displayName: cleanName,
      branch: cleanBranch,
      grade: grade ? String(grade).trim() : "",
      guardianName: guardianName ? String(guardianName).trim() : "",
      lineUserId: lineUserId ? String(lineUserId).trim() : "",
      salt,
      passwordHash,
      approvalStatus,
      mustChangeCredentials: true,
      issuedBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return res.status(200).json({
      ok: true,
      account: {
        docId,
        role: cleanRole,
        loginId: initialLoginId,
        initialPassword,
        displayName: cleanName,
        branch: cleanBranch,
        grade: grade ? String(grade).trim() : "",
        guardianName: guardianName ? String(guardianName).trim() : "",
        approvalStatus,
        requiresHqApproval: isSelfReg,
      },
    });
  } catch (err) {
    console.error("Issue Account Error:", err);
    return res.status(500).json({ error: "初期ID・パスワード発行中にエラーが発生しました" });
  }
}

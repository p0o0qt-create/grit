// api/approve-registration.js
import { db, getSessionFromReq } from "./_auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const session = getSessionFromReq(req);
    if (!session || session.role !== "hq") {
      return res.status(403).json({ error: "本部管理者権限が必要です" });
    }

    const { docId, loginId, role, decision } = req.body || {};
    if (!["approve", "reject"].includes(decision)) {
      return res.status(400).json({ error: "無効な判定です" });
    }

    const nextStatus = decision === "approve" ? "approved" : "rejected";
    const nowIso = new Date().toISOString();

    if (docId) {
      await db.collection("grit_auth_accounts").doc(String(docId)).set(
        {
          approvalStatus: nextStatus,
          reviewedBy: session.loginId,
          reviewedAt: nowIso,
          updatedAt: nowIso,
        },
        { merge: true }
      );
    } else if (loginId && role) {
      const snap = await db
        .collection("grit_auth_accounts")
        .where("role", "==", String(role))
        .where("loginId", "==", String(loginId))
        .limit(1)
        .get();
      if (!snap.empty) {
        await snap.docs[0].ref.set(
          {
            approvalStatus: nextStatus,
            reviewedBy: session.loginId,
            reviewedAt: nowIso,
            updatedAt: nowIso,
          },
          { merge: true }
        );
      }
    }

    return res.status(200).json({ ok: true, approvalStatus: nextStatus });
  } catch (err) {
    console.error("Approve Registration Error:", err);
    return res.status(500).json({ error: "承認処理中にサーバーエラーが発生しました" });
  }
}

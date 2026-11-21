// api/line-friend-status.js
import { db, getSessionFromReq } from "./_auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const session = getSessionFromReq(req);
    if (!session) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { lineUserId, manualConfirmed } = req.body || {};
    const addFriendUrl = process.env.LINE_ADD_FRIEND_URL || "";
    const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";

    let accountDocRef = null;
    let savedLineUserId = "";
    let savedFriendVerified = false;

    if (session.docId) {
      accountDocRef = db.collection("grit_auth_accounts").doc(session.docId);
      const snap = await accountDocRef.get();
      if (snap.exists) {
        const data = snap.data();
        savedLineUserId = data.lineUserId || "";
        savedFriendVerified = Boolean(data.lineFriendVerified);
      }
    }

    const targetLineUserId = String(lineUserId || savedLineUserId || "").trim();

    // ブラウザ単体（LIFF外）で友だち追加画面から戻って完了確認した場合
    if (manualConfirmed && !targetLineUserId) {
      if (accountDocRef) {
        await accountDocRef.set(
          { lineFriendVerified: true, lineVerifiedAt: new Date().toISOString() },
          { merge: true }
        );
      }
      return res.status(200).json({
        ok: true,
        isFriend: true,
        source: "manual_confirmed",
        addFriendUrl,
      });
    }

    // すでにDB上で友だち確認済みかつ新規LINE ID指定なし
    if (savedFriendVerified && !targetLineUserId) {
      return res.status(200).json({
        ok: true,
        isFriend: true,
        source: "cached_verified",
        addFriendUrl,
      });
    }

    // LINE User ID がある場合、Messaging API の Get Profile で友だち追加状態を厳密判定
    if (targetLineUserId && channelAccessToken) {
      const profileRes = await fetch(
        `https://api.line.me/v2/bot/profile/${encodeURIComponent(targetLineUserId)}`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${channelAccessToken}` },
        }
      );

      if (profileRes.ok) {
        const profileData = await profileRes.json().catch(() => ({}));
        if (accountDocRef) {
          await accountDocRef.set(
            {
              lineUserId: targetLineUserId,
              lineDisplayName: profileData.displayName || "",
              lineFriendVerified: true,
              lineVerifiedAt: new Date().toISOString(),
            },
            { merge: true }
          );
        }

        return res.status(200).json({
          ok: true,
          isFriend: true,
          lineUserId: targetLineUserId,
          lineDisplayName: profileData.displayName || "",
          addFriendUrl,
        });
      }

      // 404等の場合は「まだ公式アカウントを友だち追加していない」
      return res.status(200).json({
        ok: true,
        isFriend: false,
        lineUserId: targetLineUserId,
        addFriendUrl,
      });
    }

    // LINE User ID が未取得（通常ブラウザアクセス等）の場合は友だち追加・連携案内へ
    return res.status(200).json({
      ok: true,
      isFriend: false,
      needsLineLink: true,
      addFriendUrl,
    });
  } catch (err) {
    console.error("LINE Friend Status Error:", err);
    return res.status(500).json({ error: "LINE友だち状態の確認中にエラーが発生しました" });
  }
}

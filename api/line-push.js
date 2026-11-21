// api/line-push.js
import { getSessionFromReq } from "./_auth.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  const session = getSessionFromReq(req);
  if (!session) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!channelAccessToken) {
    return res.status(500).json({ error: "LINE_CHANNEL_ACCESS_TOKEN not configured" });
  }

  const { to, message } = req.body || {};
  const destinationId = to || process.env.LINE_DEFAULT_TO_USER_ID;

  if (!destinationId || !message || typeof message !== "string") {
    return res.status(400).json({ error: "送信先IDまたはメッセージが不足しています" });
  }

  try {
    const lineRes = await fetch("https://api.line.me/v2/bot/message/push", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${channelAccessToken}`,
      },
      body: JSON.stringify({
        to: destinationId,
        messages: [{ type: "text", text: message.slice(0, 2000) }],
      }),
    });

    const data = await lineRes.json().catch(() => ({}));
    if (!lineRes.ok) {
      return res.status(lineRes.status).json({ error: "LINE Push failed", detail: data });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "LINE API通信エラー" });
  }
}

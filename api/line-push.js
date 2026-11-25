import { requireAuth, saveDoc, sendJson } from './_utils.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  const auth = requireAuth(req, ['hq', 'reception', 'teacher', 'student', 'parent']);
  if (!auth.ok) {
    return sendJson(res, auth.status, { ok: false, error: auth.error });
  }

  try {
    const { to, messages, meta = {} } = req.body || {};
    if (!to || !Array.isArray(messages) || messages.length === 0) {
      return sendJson(res, 400, { ok: false, error: '送信先(to)とmessagesが必要です' });
    }

    const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const logId = `line_${Date.now()}`;

    if (!accessToken) {
      await saveDoc('notification_logs', logId, {
        to,
        messages,
        meta,
        sentBy: auth.user.id,
        status: 'simulated_no_token',
      });
      return sendJson(res, 200, {
        ok: true,
        simulated: true,
        message: 'LINE_CHANNEL_ACCESS_TOKEN未設定のため送信ログのみ記録しました',
      });
    }

    const lineRes = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ to, messages }),
    });

    const bodyText = await lineRes.text();
    await saveDoc('notification_logs', logId, {
      to,
      messages,
      meta,
      sentBy: auth.user.id,
      status: lineRes.ok ? 'sent' : 'failed',
      httpStatus: lineRes.status,
      response: bodyText,
    });

    if (!lineRes.ok) {
      return sendJson(res, 502, { ok: false, error: `LINE APIエラー: ${bodyText}` });
    }

    return sendJson(res, 200, { ok: true, logId });
  } catch (err) {
    console.error('LINE push error:', err);
    return sendJson(res, 500, { ok: false, error: 'LINE通知送信に失敗しました' });
  }
}

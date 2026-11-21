import crypto from 'crypto';

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;

function timingSafeCompare(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sanitizeInput(val, maxLen = 200) {
  if (val === null || val === undefined) return '';
  return String(val).replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maxLen);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const record = rateLimitMap.get(clientIp) || { count: 0, startTime: now };
  if (now - record.startTime > RATE_LIMIT_WINDOW_MS) {
    record.count = 1;
    record.startTime = now;
  } else {
    record.count += 1;
  }
  rateLimitMap.set(clientIp, record);
  if (record.count > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: 'Too Many Requests' });
  }

  const expectedSecret = process.env.INTERNAL_API_SECRET;
  const incomingSecret = req.headers['x-api-secret'];
  if (!expectedSecret || !timingSafeCompare(incomingSecret, expectedSecret)) {
    return res.status(401).json({ error: 'Unauthorized: Invalid or missing API Secret' });
  }

  const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const adminUserId = process.env.LINE_ADMIN_USER_ID;

  if (!accessToken) {
    return res.status(500).json({ error: 'LINE_CHANNEL_ACCESS_TOKEN is not configured' });
  }

  const body = req.body || {};
  const studentId = sanitizeInput(body.studentId, 32);
  const studentName = sanitizeInput(body.studentName, 60);
  const branch = sanitizeInput(body.branch, 60);
  const originalDate = sanitizeInput(body.originalDate, 60);
  const subject = sanitizeInput(body.subject, 60);
  const reason = sanitizeInput(body.reason, 300);
  const applicantRole = body.applicantRole === 'student' ? 'student' : 'guardian';
  const guardianLineUserId = sanitizeInput(body.guardianLineUserId, 64);
  const studentLineUserId = sanitizeInput(body.studentLineUserId, 64);

  const applicantLabel = applicantRole === 'student' ? '生徒本人' : '保護者様';
  const messageText = [
    '【GRIT指導学院 欠席・振替申請通知】',
    `校舎: ${branch || '未指定'}`,
    `生徒: ${studentName} (${studentId})`,
    `申請者: ${applicantLabel}`,
    `対象日時: ${originalDate}`,
    `科目: ${subject}`,
    `理由: ${reason}`
  ].join('\n');

  const lineIdPattern = /^U[0-9a-f]{32}$/i;
  const targets = new Set();
  if (adminUserId && lineIdPattern.test(adminUserId)) targets.add(adminUserId);
  if (guardianLineUserId && lineIdPattern.test(guardianLineUserId)) targets.add(guardianLineUserId);
  if (studentLineUserId && lineIdPattern.test(studentLineUserId)) targets.add(studentLineUserId);

  if (targets.size === 0) {
    return res.status(200).json({ status: 'skipped', reason: 'No valid LINE user IDs' });
  }

  try {
    const results = await Promise.all(
      Array.from(targets).map(async (toUserId) => {
        const response = await fetch('https://api.line.me/v2/bot/message/push', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`
          },
          body: JSON.stringify({
            to: toUserId,
            messages: [{ type: 'text', text: messageText }]
          })
        });
        return { to: toUserId, ok: response.ok, status: response.status };
      })
    );

    return res.status(200).json({ status: 'sent', results });
  } catch (error) {
    console.error('LINE Push API Error:', error);
    return res.status(500).json({ error: 'Failed to send LINE message' });
  }
}

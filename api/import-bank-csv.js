import {
  listDocs,
  batchSaveDocs,
  requireAuth,
  sendJson,
} from './_utils.js';
import { parseBankCsv, buildUnpaidListFromCsv } from '../lib/billing-csv.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  const auth = requireAuth(req, ['hq', 'reception']);
  if (!auth.ok) {
    return sendJson(res, auth.status, { ok: false, error: auth.error });
  }

  try {
    const { csvText, yearMonth = '2026-12', billingRecords } = req.body || {};
    if (!csvText) {
      return sendJson(res, 400, { ok: false, error: 'CSVテキストが空です' });
    }

    const csvRows = parseBankCsv(csvText);
    let targetBills = Array.isArray(billingRecords) ? billingRecords : [];

    // If no billingRecords passed, generate baseline bills from student_quotas (e.g., 1コマ 4,000円換算)
    if (targetBills.length === 0) {
      const existingBills = await listDocs('billing_records', { yearMonth });
      if (existingBills.length > 0) {
        targetBills = existingBills;
      } else {
        const students = await listDocs('student_quotas');
        targetBills = students
          .filter((s) => s.status === '在籍中')
          .map((s) => {
            const quota = s.overridesByMonth?.[yearMonth] ?? s.defaultMonthlyQuota ?? 4;
            return {
              billingId: `${yearMonth}_${s.studentId}`,
              yearMonth,
              studentId: s.studentId,
              studentName: s.name,
              branch: s.branch || '',
              billedAmount: Number(quota) * 4000,
              lineUserId: s.lineUserId || '',
            };
          });
      }
    }

    const { unpaidList, reconciledBilling } = buildUnpaidListFromCsv(csvRows, targetBills);

    await batchSaveDocs('billing_records', reconciledBilling, 'billingId');
    await batchSaveDocs('unpaid_list', unpaidList, 'id');

    return sendJson(res, 200, {
      ok: true,
      importedRows: csvRows.length,
      unpaidCount: unpaidList.length,
      totalUnpaidAmount: unpaidList.reduce((acc, item) => acc + item.unpaidAmount, 0),
      unpaidList,
      reconciledBilling,
    });
  } catch (err) {
    console.error('Import CSV error:', err);
    return sendJson(res, 500, { ok: false, error: 'CSVインポート処理に失敗しました' });
  }
}

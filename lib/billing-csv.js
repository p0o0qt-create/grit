export function parseBankCsv(csvText) {
  const cleaned = String(csvText || '').replace(/^\uFEFF/, '').trim();
  if (!cleaned) return [];

  const lines = cleaned.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) return [];

  const splitCsvLine = (line) => {
    const result = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    result.push(cur.trim());
    return result;
  };

  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line, idx) => {
    const cols = splitCsvLine(line);
    const record = { rowIndex: idx + 2 };
    headers.forEach((h, i) => {
      record[h] = cols[i] ?? '';
    });
    return record;
  });
}

export function normalizeNameKey(rawName) {
  return String(rawName || '')
    .replace(/（.*?）|\(.*?\)/g, '')
    .replace(/[\s　]+/g, '')
    .trim()
    .toLowerCase();
}

export function buildUnpaidListFromCsv(csvRows, billingRecords) {
  const paidByKey = new Map();

  for (const row of csvRows) {
    const rawName =
      row['口座名義'] ||
      row['生徒名'] ||
      row['顧客名'] ||
      row['名義'] ||
      row['studentName'] ||
      '';
    const key = normalizeNameKey(rawName);
    if (!key) continue;

    const rawPaid = String(
      row['入金額'] || row['引落額'] || row['振込額'] || row['paidAmount'] || '0'
    ).replace(/[,円\s]/g, '');
    const statusText = String(row['結果'] || row['ステータス'] || row['状態'] || '').trim();
    const isFailed = /残高不足|不能|未払|失敗|エラー|ng/i.test(statusText);
    const paidAmount = isFailed ? 0 : Math.max(0, Number(rawPaid) || 0);

    const prev = paidByKey.get(key) || {
      paidAmount: 0,
      lastPaymentDate: '',
      rawStatus: statusText,
    };

    paidByKey.set(key, {
      paidAmount: prev.paidAmount + paidAmount,
      lastPaymentDate: row['引落日'] || row['入金日'] || row['date'] || prev.lastPaymentDate,
      rawStatus: statusText || prev.rawStatus,
    });
  }

  const unpaidList = [];
  const reconciledBilling = [];

  for (const bill of billingRecords) {
    const key = normalizeNameKey(bill.studentName);
    const billedAmount = Math.max(0, Number(bill.billedAmount) || 0);
    const csvMatch = paidByKey.get(key) || {
      paidAmount: 0,
      lastPaymentDate: '',
      rawStatus: 'CSV未記載',
    };

    const unpaidAmount = Math.max(0, billedAmount - csvMatch.paidAmount);
    const paymentStatus =
      unpaidAmount === 0 && billedAmount > 0
        ? 'paid'
        : csvMatch.paidAmount > 0
          ? 'partial'
          : 'unpaid';

    const updatedBill = {
      ...bill,
      paidAmount: csvMatch.paidAmount,
      unpaidAmount,
      paymentStatus,
      lastPaymentDate: csvMatch.lastPaymentDate,
      csvStatus: csvMatch.rawStatus,
    };

    reconciledBilling.push(updatedBill);

    if (unpaidAmount > 0) {
      unpaidList.push({
        id: bill.billingId || `${bill.yearMonth}_${key}`,
        billingId: bill.billingId || `${bill.yearMonth}_${key}`,
        yearMonth: bill.yearMonth,
        studentName: bill.studentName,
        branch: bill.branch || '',
        lineUserId: bill.lineUserId || '',
        billedAmount,
        paidAmount: csvMatch.paidAmount,
        unpaidAmount,
        paymentStatus,
        csvStatus: csvMatch.rawStatus,
        lastPaymentDate: csvMatch.lastPaymentDate,
      });
    }
  }

  return { unpaidList, reconciledBilling };
}

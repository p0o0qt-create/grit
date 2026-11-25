import fs from 'node:fs';
import path from 'node:path';
import {
  listDocs,
  saveDoc,
  batchSaveDocs,
  deleteDocById,
  requireAuth,
  isFirestoreEnabled,
  sendJson,
} from './_utils.js';
import {
  generateMonthFromFirstDay,
  sortMonthSchedule,
} from '../lib/schedule-engine.js';

function loadJsonSeed(relPath) {
  try {
    const full = path.join(process.cwd(), relPath);
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch {
    return [];
  }
}

function getLessonEndDateTime(dateStr, timeSlotStr) {
  const m = String(timeSlotStr || '').match(/(\d{1,2}):(\d{2})\s*[-〜～]\s*(\d{1,2}):(\d{2})/);
  const endHour = m ? String(m[3]).padStart(2, '0') : '21';
  const endMin = m ? String(m[4]).padStart(2, '0') : '20';
  return new Date(`${dateStr}T${endHour}:${endMin}:00+09:00`);
}

function buildUnsubmittedReports(schedules, reports, now = new Date()) {
  const submittedKeySet = new Set(
    (reports || []).map((r) => `${r.scheduleId || ''}::${String(r.studentName || '').trim()}`)
  );
  const submittedDateSlotStuSet = new Set(
    (reports || []).map((r) => `${r.date || ''}::${r.timeSlot || ''}::${String(r.studentName || '').trim()}`)
  );
  const unsubmitted = [];

  for (const s of schedules || []) {
    if (s.isVacant || !s.studentName || s.status === 'absent') continue;
    const stuTrim = String(s.studentName).trim();
    const key1 = `${s.scheduleId}::${stuTrim}`;
    const key2 = `${s.date || ''}::${s.timeSlot || ''}::${stuTrim}`;
    if (submittedKeySet.has(key1) || submittedDateSlotStuSet.has(key2)) continue;

    const endDt = getLessonEndDateTime(s.date, s.timeSlot);
    if (Number.isNaN(endDt.getTime())) continue;
    const deadlineDt = new Date(endDt.getTime() + 24 * 60 * 60 * 1000);

    if (now.getTime() > deadlineDt.getTime()) {
      const overdueHours = Math.floor((now.getTime() - deadlineDt.getTime()) / (60 * 60 * 1000));
      unsubmitted.push({
        scheduleId: s.scheduleId,
        date: s.date,
        dayOfWeek: s.dayOfWeek || '',
        timeSlot: s.timeSlot || '',
        branch: s.branch || '',
        teacherName: s.teacherName || '未割当',
        studentName: stuTrim,
        subject: s.subject || '',
        lessonEndAt: endDt.toISOString(),
        deadlineAt: deadlineDt.toISOString(),
        overdueHours,
      });
    }
  }
  return unsubmitted.sort((a, b) => a.date.localeCompare(b.date) || a.timeSlot.localeCompare(b.timeSlot));
}

export default async function handler(req, res) {
  const auth = requireAuth(req);
  if (!auth.ok) {
    return sendJson(res, auth.status, { ok: false, error: auth.error });
  }

  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const yearMonth = url.searchParams.get('yearMonth') || '2026-12';

      let templates = await listDocs('monthly_templates');
      if (templates.length === 0) {
        const seed = loadJsonSeed('public/data/default-assignments.json');
        if (seed.length > 0) {
          await batchSaveDocs('monthly_templates', seed, 'assignmentId');
          templates = seed;
        }
      }

      let students = await listDocs('student_quotas');
      if (students.length === 0) {
        const seedStu = loadJsonSeed('public/data/students-master.json');
        if (seedStu.length > 0) {
          await batchSaveDocs('student_quotas', seedStu, 'studentId');
          students = seedStu;
        }
      }

      let teachers = await listDocs('teachers_master');
      if (teachers.length === 0) {
        const seedTch = loadJsonSeed('public/data/teachers-master.json');
        if (seedTch.length > 0) {
          await batchSaveDocs('teachers_master', seedTch, 'teacherId');
          teachers = seedTch;
        }
      }

      const savedSchedules = await listDocs('lesson_schedules', { yearMonth });
      const monthSchedules = generateMonthFromFirstDay(yearMonth, templates, savedSchedules);
      const absences = await listDocs('absence_requests');
      const unpaidList = await listDocs('unpaid_list');
      const reports = await listDocs('lesson_reports');
      const unsubmittedReports = buildUnsubmittedReports(monthSchedules, reports, new Date());

      return sendJson(res, 200, {
        ok: true,
        storage: isFirestoreEnabled() ? 'firestore' : 'memory',
        yearMonth,
        templates,
        students,
        teachers,
        schedules: monthSchedules,
        absences,
        unpaidList,
        reports,
        unsubmittedReports,
      });
    }

    if (req.method === 'POST') {
      const { action, payload } = req.body || {};

      if (action === 'IMPORT_DEFAULT_ASSIGNMENTS') {
        const { assignments = [] } = payload || {};
        if (!Array.isArray(assignments) || assignments.length === 0) {
          return sendJson(res, 400, { ok: false, error: '取り込む配列データがありません' });
        }

        const { normalizeAssignment } = await import('../lib/schedule-engine.js');
        const normalized = assignments.map((item, idx) => normalizeAssignment(item, idx));

        await batchSaveDocs('monthly_templates', normalized, 'assignmentId');
        return sendJson(res, 200, { ok: true, count: normalized.length });
      }

      if (action === 'SAVE_MONTH_SCHEDULES') {
        const { yearMonth, schedules = [] } = payload || {};
        const sorted = sortMonthSchedule(schedules);
        await batchSaveDocs('lesson_schedules', sorted, 'scheduleId');
        return sendJson(res, 200, { ok: true, count: sorted.length, yearMonth });
      }

      if (action === 'UPDATE_SCHEDULE_ENTRY') {
        const { entry } = payload || {};
        if (!entry?.scheduleId) {
          return sendJson(res, 400, { ok: false, error: 'scheduleIdが必要です' });
        }
        const saved = await saveDoc('lesson_schedules', entry.scheduleId, {
          ...entry,
          isCustomized: true,
        });
        return sendJson(res, 200, { ok: true, entry: saved });
      }

      if (action === 'CREATE_DEFAULT_ASSIGNMENT') {
        const { assignment } = payload || {};
        const { normalizeAssignment } = await import('../lib/schedule-engine.js');
        const existing = await listDocs('monthly_templates');
        const maxOrder = existing.reduce((m, x) => Math.max(m, Number(x.sortOrder || 0)), 0);
        const nextNum = existing.length + 1;
        const assignmentId = assignment?.assignmentId || `def_${String(nextNum).padStart(3, '0')}_${Date.now().toString().slice(-4)}`;
        const normalized = normalizeAssignment({
          ...assignment,
          assignmentId,
          sortOrder: Number(assignment?.sortOrder ?? maxOrder + 1),
          isActive: assignment?.isActive !== false,
        }, maxOrder);
        const saved = await saveDoc('monthly_templates', normalized.assignmentId, normalized);
        return sendJson(res, 200, { ok: true, assignment: saved });
      }

      if (action === 'UPDATE_DEFAULT_ASSIGNMENT') {
        const { assignment } = payload || {};
        if (!assignment?.assignmentId) {
          return sendJson(res, 400, { ok: false, error: 'assignmentIdが必要です' });
        }
        const { normalizeAssignment } = await import('../lib/schedule-engine.js');
        const normalized = normalizeAssignment(assignment);
        const saved = await saveDoc('monthly_templates', normalized.assignmentId, normalized);
        return sendJson(res, 200, { ok: true, assignment: saved });
      }

      if (action === 'DELETE_DEFAULT_ASSIGNMENT') {
        const { assignmentId } = payload || {};
        if (!assignmentId) {
          return sendJson(res, 400, { ok: false, error: 'assignmentIdが必要です' });
        }
        await deleteDocById('monthly_templates', assignmentId);
        return sendJson(res, 200, { ok: true, deletedId: assignmentId });
      }

      if (action === 'UPDATE_STUDENT_QUOTA') {
        const { student } = payload || {};
        if (!student?.studentId) {
          return sendJson(res, 400, { ok: false, error: 'studentIdが必要です' });
        }
        const saved = await saveDoc('student_quotas', student.studentId, student);
        return sendJson(res, 200, { ok: true, student: saved });
      }

      if (action === 'CREATE_ABSENCE_REQUEST') {
        const { request } = payload || {};
        const absenceId = request?.absenceId || `abs_${Date.now()}`;
        const savedReq = await saveDoc('absence_requests', absenceId, {
          ...request,
          absenceId,
          status: request?.status || 'pending',
        });
        if (request?.scheduleId) {
          await saveDoc('lesson_schedules', request.scheduleId, {
            scheduleId: request.scheduleId,
            status: 'absent',
            isCustomized: true,
          });
        }

        const accounts = await listDocs('accounts');
        const stuName = String(request?.studentName || '').trim();
        const tchName = String(request?.teacherName || '').trim();
        const brName = String(request?.branch || '').trim();

        const matchesName = (candidate, target) => {
          const c = String(candidate || '').trim();
          const t = String(target || '').trim();
          if (!c || !t) return false;
          return c === t || c.includes(t) || t.includes(c);
        };

        const linkedRecipients = accounts.filter((acc) => {
          if (acc.status === '無効') return false;
          if (acc.role === 'hq') return true;
          if (acc.role === 'reception') {
            return !acc.branch || acc.branch === '全支部' || acc.branch === '本部' || acc.branch === brName;
          }
          if (acc.role === 'teacher') {
            return matchesName(acc.linkedTeacherName || acc.name, tchName);
          }
          if (acc.role === 'student' || acc.role === 'parent') {
            return matchesName(acc.linkedStudentName || acc.name, stuName);
          }
          return false;
        });

        const msgText = [
          '【GRIT指導学院】欠席申請のお知らせ',
          `生徒様：${request?.studentName || '-'}`,
          `日時：${request?.date || ''} (${request?.dayOfWeek || ''}) ${request?.timeSlot || ''}`,
          `支部・科目：${request?.branch || '-'} / ${request?.subject || '-'}`,
          `担当講師：${request?.teacherName || '未割当'}`,
          `欠席理由：${request?.reason || '記載なし'}`,
        ].join('\n');

        const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
        const lineDeliveries = [];

        for (const rec of linkedRecipients) {
          const toId = String(rec.lineUserId || '').trim();
          const logId = `line_abs_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          if (!toId) {
            lineDeliveries.push({
              accountId: rec.id || rec.loginId,
              name: rec.name,
              role: rec.role,
              lineUserId: '',
              status: 'skipped_no_line_id',
            });
            continue;
          }

          if (!accessToken) {
            await saveDoc('notification_logs', logId, {
              to: toId,
              recipientName: rec.name,
              recipientRole: rec.role,
              messages: [{ type: 'text', text: msgText }],
              meta: { type: 'absence_request', absenceId, studentName: stuName, teacherName: tchName },
              sentBy: auth.user.id,
              status: 'simulated_no_token',
            });
            lineDeliveries.push({
              accountId: rec.id || rec.loginId,
              name: rec.name,
              role: rec.role,
              lineUserId: toId,
              status: 'simulated_no_token',
            });
          } else {
            const lineRes = await fetch('https://api.line.me/v2/bot/message/push', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({
                to: toId,
                messages: [{ type: 'text', text: msgText }],
              }),
            });
            const bodyText = await lineRes.text();
            await saveDoc('notification_logs', logId, {
              to: toId,
              recipientName: rec.name,
              recipientRole: rec.role,
              messages: [{ type: 'text', text: msgText }],
              meta: { type: 'absence_request', absenceId, studentName: stuName, teacherName: tchName },
              sentBy: auth.user.id,
              status: lineRes.ok ? 'sent' : 'failed',
              httpStatus: lineRes.status,
              response: bodyText,
            });
            lineDeliveries.push({
              accountId: rec.id || rec.loginId,
              name: rec.name,
              role: rec.role,
              lineUserId: toId,
              status: lineRes.ok ? 'sent' : 'failed',
            });
          }
        }

        return sendJson(res, 200, {
          ok: true,
          absence: savedReq,
          lineDeliveries,
        });
      }

      if (action === 'SUBMIT_LESSON_REPORT') {
        if (!['teacher', 'hq'].includes(auth.user.role)) {
          return sendJson(res, 403, { ok: false, error: '指導報告書の提出は講師または本部アカウントのみ可能です' });
        }

        const { report } = payload || {};
        const columns = Array.isArray(report?.columns)
          ? report.columns.filter((c) => String(c?.studentName || '').trim())
          : [];
        if (!report?.date || !report?.timeSlot || columns.length === 0) {
          return sendJson(res, 400, { ok: false, error: '日付・コマ・生徒氏名（1名以上）を入力してください' });
        }

        const endDt = getLessonEndDateTime(report.date, report.timeSlot);
        const deadlineDt = new Date(endDt.getTime() + 24 * 60 * 60 * 1000);
        const submittedAt = new Date().toISOString();
        const isLate = new Date(submittedAt).getTime() > deadlineDt.getTime();

        const accounts = await listDocs('accounts');
        const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
        const savedReports = [];
        const lineDeliveries = [];

        const matchesName = (candidate, target) => {
          const c = String(candidate || '').trim();
          const t = String(target || '').trim();
          if (!c || !t) return false;
          return c === t || c.includes(t) || t.includes(c);
        };

        for (let idx = 0; idx < columns.length; idx++) {
          const col = columns[idx];
          const stuName = String(col.studentName || '').trim();
          const reportId = `rep_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 6)}`;

          const record = {
            reportId,
            scheduleId: col.scheduleId || report.scheduleId || '',
            date: report.date,
            classType: report.classType || '通常CL',
            timeSlot: report.timeSlot,
            branch: report.branch || '',
            teacherName: report.teacherName || auth.user.linkedTeacherName || auth.user.name || '',
            submittedBy: auth.user.id,
            submittedByRole: auth.user.role,
            submittedAt,
            deadlineAt: deadlineDt.toISOString(),
            isLate,
            columnIndex: idx + 1,
            studentName: stuName,
            cl1Content: col.cl1Content || '',
            cl1Eval: col.cl1Eval || '',
            cl2Content: col.cl2Content || '',
            cl2Eval: col.cl2Eval || '',
            homework: col.homework || '',
            homeworkNextSlotNote: Boolean(col.homeworkNextSlotNote),
            homeworkStatus: col.homeworkStatus || '未',
            homeworkUnfinishedDetail: col.homeworkUnfinishedDetail || '',
            memoComment: col.memoComment || '',
            reportCheck: Boolean(col.reportCheck),
            substituteHandoverCheck: Boolean(col.substituteHandoverCheck),
            handoverStatus: col.substituteHandoverCheck ? 'hq_history' : 'normal',
            targetTransferTeacher: col.targetTransferTeacher || report.targetTransferTeacher || '',
            transferredToTeacher: '',
            transferredAt: '',
            transferredBy: '',
          };

          const saved = await saveDoc('lesson_reports', reportId, record);
          savedReports.push(saved);

          const recipients = accounts.filter((acc) => {
            if (acc.status === '無効') return false;
            if (acc.role === 'hq') return true;
            if (acc.role === 'student' || acc.role === 'parent') {
              return matchesName(acc.linkedStudentName || acc.kanjiName || acc.name, stuName);
            }
            return false;
          });

          const msgText = [
            '【GRIT指導学院】指導報告書が提出されました',
            `生徒様：${stuName} さん`,
            `授業日・コマ：${record.date} ${record.timeSlot}（${record.classType}／${record.branch}支部）`,
            `担当講師：${record.teacherName}`,
            `CL内容①：${record.cl1Content || '-'}（評価：${record.cl1Eval || '-'}）`,
            `CL内容②：${record.cl2Content || '-'}（評価：${record.cl2Eval || '-'}）`,
            `宿題：${record.homework || '-'}（確認：${record.homeworkStatus}${record.homeworkUnfinishedDetail ? ' ' + record.homeworkUnfinishedDetail : ''}）`,
            `メモ・コメント：${record.memoComment || '-'}`,
          ].join('\n');

          for (const rec of recipients) {
            const toId = String(rec.lineUserId || '').trim();
            const logId = `line_rep_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const status = !toId ? 'recorded_in_portal' : accessToken ? 'sent' : 'simulated_no_token';

            if (toId && accessToken) {
              await fetch('https://api.line.me/v2/bot/message/push', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${accessToken}`,
                },
                body: JSON.stringify({ to: toId, messages: [{ type: 'text', text: msgText }] }),
              });
            }

            await saveDoc('notification_logs', logId, {
              to: toId || rec.loginId,
              recipientName: rec.name,
              recipientRole: rec.role,
              messages: [{ type: 'text', text: msgText }],
              meta: { type: 'lesson_report', reportId, studentName: stuName },
              sentBy: auth.user.id,
              status,
            });

            lineDeliveries.push({
              accountId: rec.id || rec.loginId,
              name: rec.name,
              role: rec.role,
              status,
            });
          }
        }

        return sendJson(res, 200, {
          ok: true,
          reports: savedReports,
          lineDeliveries,
        });
      }

      if (action === 'TRANSFER_HANDOVER_TO_TEACHER') {
        if (!['hq', 'reception', 'teacher'].includes(auth.user.role)) {
          return sendJson(res, 403, { ok: false, error: '代行引継の転送権限がありません' });
        }
        const { reportId, targetTeacherName, note = '' } = payload || {};
        const cleanTeacher = String(targetTeacherName || '').trim();
        if (!reportId || !cleanTeacher) {
          return sendJson(res, 400, { ok: false, error: '対象の指導報告書IDと転送先講師名を指定してください' });
        }

        const reports = await listDocs('lesson_reports');
        const targetReport = reports.find((r) => String(r.reportId || r.id) === String(reportId));
        if (!targetReport) {
          return sendJson(res, 404, { ok: false, error: '対象の指導報告書が見つかりません' });
        }

        const transferredAt = new Date().toISOString();
        const updatedReport = await saveDoc('lesson_reports', targetReport.reportId || targetReport.id, {
          ...targetReport,
          substituteHandoverCheck: true,
          handoverStatus: 'transferred',
          targetTransferTeacher: cleanTeacher,
          transferredToTeacher: cleanTeacher,
          transferredAt,
          transferredBy: auth.user.id,
          transferNote: String(note || '').trim(),
        });

        const accounts = await listDocs('accounts');
        const matchesName = (candidate, target) => {
          const c = String(candidate || '').trim();
          const t = String(target || '').trim();
          if (!c || !t) return false;
          return c === t || c.includes(t) || t.includes(c);
        };
        const teacherRecipients = accounts.filter(
          (acc) => acc.status !== '無効' && acc.role === 'teacher' && matchesName(acc.linkedTeacherName || acc.kanjiName || acc.name, cleanTeacher)
        );

        const msgText = [
          '【GRIT指導学院】代行引継（指導報告書）が転送されました',
          `転送先講師：${cleanTeacher} 先生`,
          `生徒様：${updatedReport.studentName || '-'} さん`,
          `授業日・コマ：${updatedReport.date || ''} ${updatedReport.timeSlot || ''}（${updatedReport.branch || ''}支部）`,
          `担当・報告者：${updatedReport.teacherName || '-'}`,
          `CL内容①：${updatedReport.cl1Content || '-'}（評価：${updatedReport.cl1Eval || '-'}）`,
          `CL内容②：${updatedReport.cl2Content || '-'}（評価：${updatedReport.cl2Eval || '-'}）`,
          `宿題：${updatedReport.homework || '-'}（${updatedReport.homeworkStatus || '未'}）`,
          `メモ・コメント：${updatedReport.memoComment || '-'}`,
          note ? `転送補足：${note}` : '',
        ].filter(Boolean).join('\n');

        const accessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
        const deliveries = [];
        for (const rec of teacherRecipients) {
          const toId = String(rec.lineUserId || '').trim();
          const logId = `line_ho_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const status = !toId ? 'recorded_in_portal' : accessToken ? 'sent' : 'simulated_no_token';
          if (toId && accessToken) {
            await fetch('https://api.line.me/v2/bot/message/push', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${accessToken}`,
              },
              body: JSON.stringify({ to: toId, messages: [{ type: 'text', text: msgText }] }),
            });
          }
          await saveDoc('notification_logs', logId, {
            to: toId || rec.loginId,
            recipientName: rec.name,
            recipientRole: rec.role,
            messages: [{ type: 'text', text: msgText }],
            meta: { type: 'handover_transfer', reportId: updatedReport.reportId, targetTeacherName: cleanTeacher },
            sentBy: auth.user.id,
            status,
          });
          deliveries.push({ accountId: rec.id || rec.loginId, name: rec.name, status });
        }

        return sendJson(res, 200, {
          ok: true,
          report: updatedReport,
          deliveries,
        });
      }

      if (action === 'CONFIRM_RESCHEDULE') {
        const { absenceId, rescheduledEntry } = payload || {};
        if (absenceId) {
          await saveDoc('absence_requests', absenceId, {
            absenceId,
            status: 'rescheduled',
            rescheduledScheduleId: rescheduledEntry?.scheduleId || null,
          });
        }
        if (rescheduledEntry?.scheduleId) {
          await saveDoc('lesson_schedules', rescheduledEntry.scheduleId, {
            ...rescheduledEntry,
            status: 'rescheduled',
            isCustomized: true,
          });
        }
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 400, { ok: false, error: '未対応のactionです' });
    }

    return sendJson(res, 405, { ok: false, error: 'Method Not Allowed' });
  } catch (err) {
    console.error('Schedules API error:', err);
    return sendJson(res, 500, { ok: false, error: err.message || 'サーバーエラー' });
  }
}

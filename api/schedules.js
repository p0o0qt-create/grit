import fs from 'node:fs';
import path from 'node:path';
import {
  listDocs,
  saveDoc,
  batchSaveDocs,
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
      });
    }

    if (req.method === 'POST') {
      const { action, payload } = req.body || {};

      if (action === 'IMPORT_DEFAULT_ASSIGNMENTS') {
        const { assignments = [] } = payload || {};
        if (!Array.isArray(assignments) || assignments.length === 0) {
          return sendJson(res, 400, { ok: false, error: '取り込む配列データがありません' });
        }

        const normalized = assignments.map((item, idx) => ({
          ...item,
          assignmentId: String(
            item.assignmentId || `def_${String(idx + 1).padStart(3, '0')}`
          ),
          sortOrder: Number(item.sortOrder ?? idx + 1),
          isActive: item.isActive !== false,
        }));

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

      if (action === 'UPDATE_DEFAULT_ASSIGNMENT') {
        const { assignment } = payload || {};
        if (!assignment?.assignmentId) {
          return sendJson(res, 400, { ok: false, error: 'assignmentIdが必要です' });
        }
        const saved = await saveDoc('monthly_templates', assignment.assignmentId, assignment);
        return sendJson(res, 200, { ok: true, assignment: saved });
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
        return sendJson(res, 200, { ok: true, absence: savedReq });
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

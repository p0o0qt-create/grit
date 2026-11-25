const WEEKDAY_ORDER = ['月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日', '日曜日'];
const JS_DAY_TO_JP = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];

export function isVacantSlot(item) {
  if (item?.isVacant === true || item?.status === 'vacant') return true;
  const student = String(item?.studentName ?? '').trim();
  const subject = String(item?.subject ?? '').trim();
  return student === '' || student === '空き' || subject === '空き' || subject === '空き枠';
}

export function normalizeAssignment(item, idx = 0) {
  const vacant = isVacantSlot(item);
  const rawStudent = String(item?.studentName ?? '').trim();
  const teacherName = String(
    item?.teacherName ?? item?.teacher ?? item?.defaultTeacherName ?? ''
  ).trim();
  const rawSubject = String(item?.subject ?? '').trim();

  return {
    ...item,
    assignmentId: String(
      item?.assignmentId || `def_${String(idx + 1).padStart(3, '0')}`
    ),
    sortOrder: Number(item?.sortOrder ?? idx + 1),
    dayOfWeek: String(item?.dayOfWeek ?? '').trim(),
    branch: String(item?.branch ?? '').trim(),
    timeSlot: String(item?.timeSlot ?? '').trim(),
    teacherName,
    defaultTeacherName: String(item?.defaultTeacherName ?? teacherName).trim(),
    studentName: vacant ? (rawStudent || '空き') : rawStudent,
    school: String(item?.school ?? '').trim(),
    grade: String(item?.grade ?? '').trim(),
    subject: vacant ? (rawSubject || '空き枠') : rawSubject,
    isVacant: vacant,
    isActive: item?.isActive !== false && item?.isActivePair !== false,
  };
}

export function generateMonthFromFirstDay(yearMonth, assignments, existingEntries = []) {
  const [yStr, mStr] = String(yearMonth).split('-');
  const year = Number(yStr);
  const monthIdx = Number(mStr) - 1;
  if (!year || monthIdx < 0 || monthIdx > 11) return [];

  const lastDay = new Date(year, monthIdx + 1, 0).getDate();
  const existingMap = new Map(
    existingEntries.map((item) => [item.scheduleId, item])
  );

  const normalizedTemplates = (assignments || [])
    .map((a, i) => normalizeAssignment(a, i))
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  const result = [];
  for (let day = 1; day <= lastDay; day++) {
    const dateObj = new Date(year, monthIdx, day);
    const dayOfWeek = JS_DAY_TO_JP[dateObj.getDay()];
    const dateStr = `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

    const dayAssignments = normalizedTemplates.filter(
      (a) => a.dayOfWeek === dayOfWeek && a.isActive !== false
    );

    dayAssignments.forEach((def, idxInDay) => {
      const scheduleId = `${dateStr}_${def.assignmentId}`;
      const saved = existingMap.get(scheduleId);
      if (saved) {
        const mergedTeacher = String(
          saved.teacherName || def.teacherName || ''
        ).trim();
        const vacant = isVacantSlot({ ...def, ...saved });
        result.push({
          ...def,
          ...saved,
          dayOrder: idxInDay + 1,
          sortOrder: def.sortOrder ?? saved.sortOrder ?? idxInDay + 1,
          teacherName: mergedTeacher,
          defaultTeacherName: String(
            saved.defaultTeacherName || def.defaultTeacherName || mergedTeacher
          ).trim(),
          studentName: vacant
            ? (String(saved.studentName || def.studentName || '空き').trim() || '空き')
            : String(saved.studentName ?? def.studentName ?? '').trim(),
          isVacant: vacant,
          status: saved.status || (vacant ? 'vacant' : 'scheduled'),
        });
      } else {
        result.push({
          scheduleId,
          assignmentId: def.assignmentId,
          sortOrder: def.sortOrder,
          yearMonth,
          date: dateStr,
          dayOfWeek,
          dayOrder: idxInDay + 1,
          branch: def.branch,
          timeSlot: def.timeSlot,
          defaultTeacherName: def.defaultTeacherName || def.teacherName,
          teacherName: def.teacherName,
          studentName: def.studentName,
          school: def.school || '',
          grade: def.grade || '',
          subject: def.subject || '',
          isVacant: def.isVacant,
          status: def.isVacant ? 'vacant' : 'scheduled',
          isCustomized: false,
          rescheduleFromId: null,
          note: '',
        });
      }
    });
  }

  for (const saved of existingEntries) {
    if (saved.yearMonth === yearMonth && !result.some((r) => r.scheduleId === saved.scheduleId)) {
      result.push(saved);
    }
  }

  return sortMonthSchedule(result);
}

export function sortMonthSchedule(entries) {
  return [...entries].sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const sortA = Number(a.sortOrder ?? a.dayOrder ?? 0);
    const sortB = Number(b.sortOrder ?? b.dayOrder ?? 0);
    if (sortA !== sortB) return sortA - sortB;
    const wdA = WEEKDAY_ORDER.indexOf(a.dayOfWeek);
    const wdB = WEEKDAY_ORDER.indexOf(b.dayOfWeek);
    if (wdA !== wdB) return wdA - wdB;
    return (a.dayOrder || 0) - (b.dayOrder || 0);
  });
}

export function buildAvailableTeacherOptions(allTeachers, monthSchedules, { date, branch, timeSlot }) {
  const busyTeachers = new Set();
  for (const row of monthSchedules) {
    if (row.status === 'cancelled' || row.status === 'absent' || row.status === 'vacant' || row.isVacant) {
      continue;
    }
    if (date && row.date !== date) continue;
    if (timeSlot && row.timeSlot !== timeSlot) continue;
    if (row.teacherName) busyTeachers.add(row.teacherName.trim());
  }

  return allTeachers
    .filter((t) => {
      if (t.status && t.status !== '在職中') return false;
      const branchOk = !branch || !Array.isArray(t.branches) || t.branches.length === 0 || t.branches.includes(branch);
      return branchOk && !busyTeachers.has(t.name.trim());
    })
    .map((t) => ({
      value: t.name,
      label: `${t.name}（${date || '対象日'} ${timeSlot || '全コマ'} 空き）`,
    }));
}

export function buildAbsentStudentOptions(absenceRequests, studentsMaster = [], yearMonth = '') {
  const byStudent = new Map();
  for (const req of absenceRequests) {
    if (req.status === 'rejected') continue;
    const key = String(req.studentName || '').trim();
    if (!key || key === '空き') continue;
    const cur = byStudent.get(key) || {
      studentName: key,
      branch: req.branch || '',
      subject: req.subject || '',
      absentCount: 0,
      rescheduledCount: 0,
      pendingRequests: [],
    };
    cur.absentCount += 1;
    if (req.status === 'rescheduled') {
      cur.rescheduledCount += 1;
    } else {
      cur.pendingRequests.push(req);
    }
    byStudent.set(key, cur);
  }

  return Array.from(byStudent.values())
    .map((item) => {
      const remainingDays = Math.max(0, item.absentCount - item.rescheduledCount);
      const stuMeta = studentsMaster.find((s) => s.name === item.studentName);
      const quota = stuMeta
        ? (stuMeta.overridesByMonth?.[yearMonth] ?? stuMeta.defaultMonthlyQuota ?? 4)
        : 4;
      return {
        ...item,
        remainingDays,
        monthlyQuota: quota,
        value: item.studentName,
        label: `${item.studentName}（${item.branch || '未定'} / ${item.subject || '科目未定'}）— 振替残 ${remainingDays}日（月設定:${quota}コマ）`,
      };
    })
    .filter((o) => o.remainingDays > 0);
}

export function getEffectiveMonthlyQuota(student, yearMonth) {
  if (
    student?.overridesByMonth &&
    yearMonth &&
    student.overridesByMonth[yearMonth] !== undefined &&
    student.overridesByMonth[yearMonth] !== null &&
    student.overridesByMonth[yearMonth] !== ''
  ) {
    return Number(student.overridesByMonth[yearMonth]);
  }
  return Number(student?.defaultMonthlyQuota ?? 4);
}

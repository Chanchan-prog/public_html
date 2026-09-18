import React from 'react';
import { apiGet, apiPost, apiPut } from '../../services/api.js';
import Table from "../../components/Table.jsx";
import Modal from "../../components/Modal.jsx";
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import { MasterPageHeader, MasterStats, MasterToolbar, MasterSearch, MasterResults, MasterSelect } from '../../components/MasterDataPage.jsx';

const TERM_ORDER = ['1st sem', '2nd sem', 'summer'];
const TERM_LABELS = {
  '1st sem': '1st Semester',
  '2nd sem': '2nd Semester',
  'summer': 'Summer',
};
const TERM_RANK = {
  '1st sem': 1,
  '2nd sem': 2,
  'summer': 3,
};
const DAY_MS = 24 * 60 * 60 * 1000;
const EMPTY_SEMESTER_ROWS = TERM_ORDER.map((term) => ({ term, start_date: '', end_date: '', semester_id: null }));

function getApiErrorMessage(err, fallbackMessage) {
  const codeToMessage = (rawCode) => {
    const code = String(rawCode || '').toLowerCase().trim();
    if (!code) return null;
    if (code === 'school_year_date_conflict') {
      return 'The selected school year dates overlap an existing school year. Please choose a non-conflicting date range.';
    }
    if (code === 'duplicate_school_year') {
      return 'A school year with the same name already exists. Please use a different school year name.';
    }
    if (code === 'school_year_restricted') {
      return 'This school year already has schedules or attendance records. Date edits are restricted to protect finalized data.';
    }
    if (code === 'school_year_not_completed') {
      return 'This school year is not yet completed. You can only archive completed (ended) school years.';
    }
    if (code === 'semester_date_conflict') {
      return 'The semester dates conflict with another semester. Overlapping semester dates are not allowed.';
    }
    if (code === 'semester_outside_school_year') {
      return 'Semester dates must stay within the selected school year date range.';
    }
    if (code === 'semester_restricted') {
      return 'This semester already has schedules or attendance records. Date edits are restricted to protect finalized data.';
    }
    if (code === 'semester_sequence_invalid') {
      return 'Semester order is invalid. Please keep the sequence as 1st Semester, 2nd Semester, then Summer.';
    }
    if (code === 'semester_batch_missing_term') {
      return 'Some required semesters are missing. Please complete all three terms before saving.';
    }
    if (code === 'semester_already_generated') {
      return 'Semesters are already set up for this school year. You can edit all three terms from the School Year table.';
    }
    return null;
  };

  const body = err?.body;
  if (body && typeof body === 'object') {
    if (body.message && String(body.message).trim()) return String(body.message).trim();
    const mapped = codeToMessage(body.error);
    if (mapped) return mapped;
    const code = String(body.error || '').toLowerCase();
    if (code) return code.replace(/_/g, ' ');
  }
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (err?.message && String(err.message).trim()) {
    const msg = String(err.message).trim();
    const matchedCode = msg.match(/\b([a-z_]+(?:conflict|restricted|duplicate|validation|failed|error))\b/i);
    const mapped = codeToMessage(matchedCode ? matchedCode[1] : '');
    if (mapped) return mapped;
    if (/Network request failed/i.test(msg)) {
      return 'Unable to complete the request right now. Please check your connection and try again.';
    }
    return msg;
  }
  return fallbackMessage;
}

function parseIsoDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) return null;
  return date;
}

function toIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function suggestSemesterRanges(startIso, endIso) {
  const schoolYearStart = parseIsoDate(startIso);
  const schoolYearEnd = parseIsoDate(endIso);

  if (!schoolYearStart || !schoolYearEnd || schoolYearStart > schoolYearEnd) {
    return TERM_ORDER.map((term) => ({ term, start_date: startIso || '', end_date: endIso || '' }));
  }

  const totalDays = Math.max(1, Math.floor((schoolYearEnd - schoolYearStart) / DAY_MS) + 1);
  const weightedDays = Math.max(totalDays, 3);

  let firstLen = Math.max(1, Math.round(weightedDays * 0.45));
  let secondLen = Math.max(1, Math.round(weightedDays * 0.40));
  let thirdLen = weightedDays - firstLen - secondLen;

  while (thirdLen < 1) {
    if (secondLen > 1) {
      secondLen -= 1;
      thirdLen += 1;
      continue;
    }
    if (firstLen > 1) {
      firstLen -= 1;
      thirdLen += 1;
      continue;
    }
    break;
  }

  const roughRanges = [
    { term: '1st sem', start: schoolYearStart, end: addDays(schoolYearStart, firstLen - 1) },
    { term: '2nd sem', start: addDays(schoolYearStart, firstLen), end: addDays(schoolYearStart, firstLen + secondLen - 1) },
    { term: 'summer', start: addDays(schoolYearStart, firstLen + secondLen), end: addDays(schoolYearStart, firstLen + secondLen + thirdLen - 1) },
  ];

  const clampToSchoolYear = (date) => (date > schoolYearEnd ? new Date(schoolYearEnd) : date);

  return roughRanges.map((range) => {
    const start = clampToSchoolYear(range.start);
    const end = clampToSchoolYear(range.end);
    const safeEnd = end < start ? new Date(start) : end;
    return { term: range.term, start_date: toIsoDate(start), end_date: toIsoDate(safeEnd) };
  });
}

function validateSemesterPlan(rows, schoolYearStartIso, schoolYearEndIso) {
  const schoolYearStart = parseIsoDate(schoolYearStartIso);
  const schoolYearEnd = parseIsoDate(schoolYearEndIso);
  if (!schoolYearStart || !schoolYearEnd) return 'School year date range is invalid.';

  const byTerm = {};
  for (const row of rows) {
    const label = TERM_LABELS[row.term] || row.term;
    const start = parseIsoDate(row.start_date);
    const end = parseIsoDate(row.end_date);

    if (!start || !end) return `${label} requires valid start and end dates.`;
    if (start > end) return `${label} start date must be before end date.`;
    if (start < schoolYearStart || end > schoolYearEnd) {
      return `${label} must stay within school year range ${schoolYearStartIso} to ${schoolYearEndIso}.`;
    }

    byTerm[row.term] = { start, end };
  }

  for (const term of TERM_ORDER) {
    if (!byTerm[term]) return `Missing ${TERM_LABELS[term] || term}.`;
  }

  for (let i = 1; i < TERM_ORDER.length; i += 1) {
    const prevTerm = TERM_ORDER[i - 1];
    const currTerm = TERM_ORDER[i];
    const prev = byTerm[prevTerm];
    const curr = byTerm[currTerm];
    if (prev.start > curr.start) return `${TERM_LABELS[currTerm]} should start after ${TERM_LABELS[prevTerm]}.`;
    if (prev.end >= curr.start) return `${TERM_LABELS[currTerm]} must start after ${TERM_LABELS[prevTerm]} ends.`;
  }

  return null;
}

function buildSemesterEditRows(schoolYear, semesterList = []) {
  const suggestedMap = new Map(
    suggestSemesterRanges(schoolYear?.start_date, schoolYear?.end_date).map((row) => [row.term, row])
  );
  const existingMap = new Map();
  semesterList.forEach((row) => {
    const term = String(row.term || '').toLowerCase();
    if (TERM_ORDER.includes(term) && !existingMap.has(term)) {
      existingMap.set(term, row);
    }
  });

  return TERM_ORDER.map((term) => {
    const existing = existingMap.get(term);
    const fallback = suggestedMap.get(term) || { start_date: schoolYear?.start_date || '', end_date: schoolYear?.end_date || '' };
    return {
      term,
      semester_id: existing?.semester_id || null,
      start_date: existing?.start_date || fallback.start_date,
      end_date: existing?.end_date || fallback.end_date,
      status: existing?.status || 'inactive',
    };
  });
}

function SchoolYearIndex() {
  const [items, setItems] = React.useState([]);
  const [semesters, setSemesters] = React.useState([]);
  const [expandedSessionId, setExpandedSessionId] = React.useState(null);

  const [showModal, setShowModal] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [form, setForm] = React.useState({ session_name: '', start_date: '', end_date: '' });
  const [loading, setLoading] = React.useState(true);
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('active');
  const [showArchived, setShowArchived] = React.useState(false);

  const [showSemesterBatchModal, setShowSemesterBatchModal] = React.useState(false);
  const [semesterBatchTarget, setSemesterBatchTarget] = React.useState(null);
  const [semesterBatchRows, setSemesterBatchRows] = React.useState(() => EMPTY_SEMESTER_ROWS.map((row) => ({ ...row })));
  const [semesterSaving, setSemesterSaving] = React.useState(false);

  const runWithFallback = async (primary, fallback) => {
    try { return await primary(); } catch (err) { if (err?.status === 405 || err?.status === 500) return await fallback(); throw err; }
  };

  const loadData = React.useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const [currentYears, archivedYears, sems] = await Promise.all([apiGet('school-years'), apiGet('school-years?archived=1'), apiGet('semesters')]);
      const yearMap = new Map();
      [...(Array.isArray(currentYears) ? currentYears : []), ...(Array.isArray(archivedYears) ? archivedYears : [])]
        .forEach((year) => yearMap.set(String(year.session_id), year));
      setItems(Array.from(yearMap.values()));
      setSemesters(Array.isArray(sems) ? sems.filter((x) => String(x.status || '').toLowerCase() !== 'archive') : []);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    (async () => {
      try {
        await loadData();
      } catch (e) {
        console.error(e);
      }
    })();
  }, [loadData]);

  useAutoRefresh({
    refresh: () => loadData({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.ADMIN,
    enabled: !showModal && !showSemesterBatchModal,
  });

  const semesterCountBySession = React.useMemo(() => {
    const map = new Map();
    semesters.forEach((row) => {
      const key = Number(row.session_id || row.school_year_id || 0);
      if (!key) return;
      map.set(key, (map.get(key) || 0) + 1);
    });
    return map;
  }, [semesters]);

  const filteredItems = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((item) => (!query || `${item.session_name || ''} ${item.start_date || ''} ${item.end_date || ''}`.toLowerCase().includes(query)) && String(item.status || '').toLowerCase() === statusFilter);
  }, [items, search, statusFilter]);

  const semestersBySession = React.useMemo(() => {
    const map = new Map();
    semesters.forEach((row) => {
      const key = Number(row.session_id || row.school_year_id || 0);
      if (!key) return;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    });
    for (const [key, list] of map.entries()) {
      map.set(
        key,
        [...list].sort((a, b) => {
          const rankA = TERM_RANK[String(a.term || '').toLowerCase()] || 99;
          const rankB = TERM_RANK[String(b.term || '').toLowerCase()] || 99;
          if (rankA !== rankB) return rankA - rankB;
          return String(a.start_date || '').localeCompare(String(b.start_date || ''));
        })
      );
    }
    return map;
  }, [semesters]);

  const openModal = (it = null) => {
    if (it) {
      setEditing(it);
      setForm({ session_name: it.session_name || '', start_date: it.start_date || '', end_date: it.end_date || '' });
    } else {
      const today = new Date();
      setEditing(null);
      setForm({
        session_name: '',
        start_date: toIsoDate(today),
        end_date: toIsoDate(addDays(today, 365)),
      });
    }
    setShowModal(true);
  };

  const closeModal = () => setShowModal(false);
  const handleChange = (e) => setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));

  const openSemesterBatchModal = (schoolYearRow) => {
    const sessionId = Number(schoolYearRow?.session_id || 0);
    if (!sessionId) return;

    const schoolYear = {
      session_id: sessionId,
      session_name: schoolYearRow?.session_name || '',
      start_date: schoolYearRow?.start_date || '',
      end_date: schoolYearRow?.end_date || '',
    };
    const list = semestersBySession.get(sessionId) || [];
    const rows = buildSemesterEditRows(schoolYear, list);

    setSemesterBatchTarget(schoolYear);
    setSemesterBatchRows(rows);
    setShowSemesterBatchModal(true);
  };

  const closeSemesterBatchModal = () => {
    setShowSemesterBatchModal(false);
    setSemesterBatchTarget(null);
    setSemesterBatchRows(EMPTY_SEMESTER_ROWS.map((row) => ({ ...row })));
  };

  const handleSemesterBatchRowChange = (term, key, value) => {
    setSemesterBatchRows((prev) => prev.map((row) => (row.term === term ? { ...row, [key]: value } : row)));
  };

  const saveSemesterBatchPlan = async (sessionId, rows) => {
    const normalizedRows = rows.map((row) => ({
      term: row.term,
      start_date: row.start_date,
      end_date: row.end_date,
    }));
    const payload = { semesters: normalizedRows };

    try {
      await apiPost(`school-years/${sessionId}/update-semesters`, payload);
      return;
    } catch (batchErr) {
      const rawMessage = `${String(batchErr?.body?.message || '')} ${String(batchErr?.message || '')}`.toLowerCase();
      const shouldFallback =
        batchErr?.status === 404 ||
        batchErr?.status === 405 ||
        rawMessage.includes('session_name is required') ||
        rawMessage.includes('start_date and end_date are required');
      if (!shouldFallback) throw batchErr;
    }

    const normalizeTerm = (value) => String(value || '').toLowerCase().trim();
    const existing = semestersBySession.get(Number(sessionId)) || [];
    const existingByTerm = new Map(existing.map((row) => [normalizeTerm(row.term), row]));

    if (existingByTerm.size === 0) {
      await apiPost(`school-years/${sessionId}/generate-semesters`, payload);
      return;
    }

    const missingTerms = TERM_ORDER.filter((term) => !existingByTerm.has(term));
    if (missingTerms.length > 0) {
      const missingLabels = missingTerms.map((term) => TERM_LABELS[term] || term).join(', ');
      throw new Error(`Missing semester records: ${missingLabels}. Please complete setup for all three semesters first.`);
    }

    for (const row of normalizedRows) {
      const fallbackRow = existingByTerm.get(normalizeTerm(row.term));
      const semesterId = Number(
        (rows.find((x) => x.term === row.term)?.semester_id) ||
        fallbackRow?.semester_id ||
        0
      );
      if (!semesterId) {
        throw new Error(`Unable to resolve semester record for ${TERM_LABELS[row.term] || row.term}.`);
      }
      await runWithFallback(
        () => apiPut(`semesters/${semesterId}`, { start_date: row.start_date, end_date: row.end_date }),
        () => apiPost(`semesters/${semesterId}/update`, { start_date: row.start_date, end_date: row.end_date })
      );
    }
  };

  const handleSemesterBatchSubmit = async (e) => {
    e.preventDefault();
    if (!semesterBatchTarget?.session_id) return;

    const validationError = validateSemesterPlan(
      semesterBatchRows,
      semesterBatchTarget.start_date,
      semesterBatchTarget.end_date
    );
    if (validationError) {
      try {
        if (window.Swal) {
          await window.Swal.fire({
            icon: 'warning',
            title: 'Invalid Semester Dates',
            text: validationError,
          });
        }
      } catch (swalErr) {}
      return;
    }

    const confirmation = window.Swal ? await window.Swal.fire({ title:'Save Semester Plan?', text:`Update all three semester date ranges for ${semesterBatchTarget.session_name || 'this school year'}?`, icon:'question', showCancelButton:true, confirmButtonText:'Save Semesters', confirmButtonColor:'#198754' }) : { isConfirmed:confirm('Save all three semester date ranges?') };
    if (!confirmation.isConfirmed) return;

    setSemesterSaving(true);
    try {
      await saveSemesterBatchPlan(semesterBatchTarget.session_id, semesterBatchRows);

      await loadData();
      closeSemesterBatchModal();
      setExpandedSessionId(semesterBatchTarget.session_id);

      try {
        if (window.Swal) {
          await window.Swal.fire({
            icon: 'success',
            title: 'Semesters Updated',
            text: 'All three semester dates were saved successfully.',
            timer: 1700,
            showConfirmButton: false,
          });
        }
      } catch (swalErr) {}
    } catch (err) {
      try {
        if (window.Swal) {
          await window.Swal.fire({
            icon: 'error',
            title: 'Unable to Save Semesters',
            text: getApiErrorMessage(err, 'Failed to save the semester plan.'),
          });
        }
      } catch (swalErr) {}
    } finally {
      setSemesterSaving(false);
    }
  };

  const handleSchoolYearRowClick = (row) => {
    const sessionId = Number(row?.session_id || 0);
    if (!sessionId) return;
    setExpandedSessionId((prev) => (Number(prev) === sessionId ? null : sessionId));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);

    const start = parseIsoDate(form.start_date);
    const end = parseIsoDate(form.end_date);
    if (!start || !end || start > end) {
      try { if (window.Swal) await window.Swal.fire({ icon: 'warning', title: 'Invalid Date Range', text: 'Please set the start date earlier than or equal to the end date.' }); } catch (e2) {}
      setLoading(false);
      return;
    }

    const confirmation = window.Swal ? await window.Swal.fire({ title: editing ? 'Save School Year Changes?' : 'Create School Year?', text:`${form.session_name || 'School year'}: ${form.start_date} to ${form.end_date}.`, icon:'question', showCancelButton:true, confirmButtonText: editing ? 'Save Changes' : 'Create School Year', confirmButtonColor:'#198754' }) : { isConfirmed:confirm(`${editing ? 'Save changes to' : 'Create'} this school year?`) };
    if (!confirmation.isConfirmed) { setLoading(false); return; }

    try {
      if (editing) {
        const datesChanged =
          String(form.start_date || '') !== String(editing.start_date || '') ||
          String(form.end_date || '') !== String(editing.end_date || '');

        await runWithFallback(
          () => apiPut(`school-years/${editing.session_id}`, form),
          () => apiPost(`school-years/${editing.session_id}/update`, form)
        );

        let semesterSyncWarning = null;
        if (datesChanged) {
          const suggestedRows = suggestSemesterRanges(form.start_date, form.end_date).map((row) => ({
            term: row.term,
            start_date: row.start_date,
            end_date: row.end_date,
            semester_id: null,
          }));
          const semesterValidationError = validateSemesterPlan(
            suggestedRows,
            form.start_date,
            form.end_date
          );
          if (semesterValidationError) {
            semesterSyncWarning = `School year dates were saved, but semester auto-sync was skipped: ${semesterValidationError}`;
          } else {
            try {
              await saveSemesterBatchPlan(editing.session_id, suggestedRows);
            } catch (semSyncErr) {
              semesterSyncWarning = getApiErrorMessage(
                semSyncErr,
                'School year dates were saved, but semester auto-sync could not be completed.'
              );
            }
          }
        }

        await loadData();
        closeModal();

        try {
          if (window.Swal) {
            await window.Swal.fire({
              icon: semesterSyncWarning ? 'warning' : 'success',
              title: semesterSyncWarning ? 'School Year Updated With Notice' : 'School Year Updated Successfully',
              text: semesterSyncWarning || (datesChanged ? 'Your school year and semester dates were updated automatically.' : 'Your school year changes were saved.'),
              timer: semesterSyncWarning ? undefined : 1800,
              showConfirmButton: !!semesterSyncWarning ? true : false,
            });
          }
        } catch (e3) {}
      } else {
        const created = await apiPost('school-years', form);
        const sessionId = Number(created?.session_id || 0);
        if (!sessionId) throw new Error('School year created but missing session_id in response.');

        const newSchoolYear = {
          session_id: sessionId,
          session_name: created?.session_name || form.session_name,
          start_date: created?.start_date || form.start_date,
          end_date: created?.end_date || form.end_date,
          status: created?.status || 'inactive',
        };

        const suggestedRows = suggestSemesterRanges(newSchoolYear.start_date, newSchoolYear.end_date);
        const semesterValidationError = validateSemesterPlan(
          suggestedRows,
          newSchoolYear.start_date,
          newSchoolYear.end_date
        );
        if (semesterValidationError) {
          throw new Error(`School year was created, but semester auto-generation could not continue: ${semesterValidationError}`);
        }

        try {
          await apiPost(`school-years/${newSchoolYear.session_id}/generate-semesters`, {
            semesters: suggestedRows.map((row) => ({
              term: row.term,
              start_date: row.start_date,
              end_date: row.end_date,
            })),
          });
        } catch (genErr) {
          await loadData();
          closeModal();
          setExpandedSessionId(newSchoolYear.session_id);
          try {
            if (window.Swal) {
              await window.Swal.fire({
                icon: 'warning',
                title: 'School Year Created, Semesters Pending',
                text: getApiErrorMessage(
                  genErr,
                  'The school year was created, but automatic semester setup failed. Open the school year row and use Edit Semesters.'
                ),
              });
            }
          } catch (e3) {}
          return;
        }

        try {
          if (window.Swal) {
            await window.Swal.fire({
              icon: 'success',
              title: 'School Year and Semesters Created',
              text: 'Three semesters were auto-generated based on the school year date range.',
              timer: 1800,
              showConfirmButton: false,
            });
          }
        } catch (e3) {}

        await loadData();
        closeModal();
        setExpandedSessionId(newSchoolYear.session_id);
      }
    } catch (err) {
      try {
        if (window.Swal) await window.Swal.fire({
          icon: 'error',
          title: 'Unable to Save School Year',
          text: getApiErrorMessage(err, 'We could not save the school year right now. Please try again.'),
        });
      } catch (e4) {}
    } finally {
      setLoading(false);
    }
  };

  const handleArchive = async (it) => {
    try {
      const res = window.Swal
        ? await window.Swal.fire({
            title: 'Archive School Year?',
            text: 'This will move the school year to the archive database. Only completed school years can be archived, and all semesters under this school year must be archived first.',
            icon: 'warning',
            showCancelButton: true,
          })
        : { isConfirmed: confirm('Archive School Year?') };

      if (!res.isConfirmed) return;

      await runWithFallback(
        () => apiPut(`school-years/${it.session_id}`, { status: 'archive' }),
        () => apiPost(`school-years/${it.session_id}/update`, { status: 'archive' })
      );

      await loadData();
      try {
        if (window.Swal) await window.Swal.fire({
          icon: 'success',
          title: 'School Year Archived',
          text: 'The school year was moved to the archive database successfully.',
          timer: 1700,
          showConfirmButton: false,
        });
      } catch (e) {}
    } catch (err) {
      try { if (window.Swal) await window.Swal.fire({ icon: 'error', title: 'Action Denied', text: getApiErrorMessage(err, 'Archive failed. Please clear semesters first.') }); } catch (e) {}
    }
  };

  const handleRestore = async (it) => {
    try {
      const res = window.Swal
        ? await window.Swal.fire({
            title: 'Restore School Year?',
            text: 'The school year will return to the current database as inactive so it can be reviewed safely.',
            icon: 'question',
            showCancelButton: true,
          })
        : { isConfirmed: confirm('Restore School Year?') };
      if (!res.isConfirmed) return;

      await apiPost(`school-years/${it.session_id}/restore`, {});
      await loadData();
      if (window.Swal) await window.Swal.fire({ icon: 'success', title: 'School Year Restored', text: 'The school year was restored as inactive.', timer: 1700, showConfirmButton: false });
    } catch (err) {
      if (window.Swal) await window.Swal.fire({ icon: 'error', title: 'Restore Failed', text: getApiErrorMessage(err, 'The school year could not be restored.') });
    }
  };

  const showSemesterEditRestrictedAlert = async () => {
    try {
      if (window.Swal) {
        await window.Swal.fire({
          icon: 'info',
          title: 'Semester Edit Restricted',
          text: 'Semester dates cannot be edited once schedules or attendance records exist.',
        });
      }
    } catch (e) {}
  };

  const renderExpandedSemesterRow = (schoolYearRow) => {
    const sessionId = Number(schoolYearRow?.session_id || 0);
    const list = semestersBySession.get(sessionId) || [];
    const hasOperationalData = Number(schoolYearRow?.schedule_count || 0) > 0 || Number(schoolYearRow?.attendance_count || 0) > 0;

    if (list.length === 0) {
      return (
        <div className="rounded-lg border border-gray-200 bg-white">
          <div className="px-3 py-2 border-b border-gray-200 text-xs font-semibold text-gray-600 uppercase tracking-wide">
            {schoolYearRow?.session_name || 'School Year'} Semesters
          </div>
          <div className="px-3 py-3 flex items-center justify-between gap-3 text-sm text-gray-600">
            <span>No semesters found yet for this school year.</span>
            <button
              type="button"
              data-no-row-click
              className="btn btn-sm btn-secondary"
              onClick={() => (hasOperationalData ? showSemesterEditRestrictedAlert() : openSemesterBatchModal(schoolYearRow))}
            >
              <i className="bi bi-pencil-square me-1" aria-hidden="true"></i>
              {hasOperationalData ? 'Edit Restricted' : 'Edit'}
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="rounded-lg border border-gray-200 bg-white">
        <div className="px-3 py-2 border-b border-gray-200 flex items-center justify-between gap-3">
          <span className="text-xs font-semibold text-gray-600 uppercase tracking-wide">
            {schoolYearRow?.session_name || 'School Year'} Semesters
          </span>
          <button
            type="button"
            data-no-row-click
            className="btn btn-sm btn-secondary"
            onClick={() => (hasOperationalData ? showSemesterEditRestrictedAlert() : openSemesterBatchModal(schoolYearRow))}
          >
            <i className="bi bi-pencil-square me-1" aria-hidden="true"></i>
            {hasOperationalData ? 'Edit Restricted' : 'Edit'}
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Term</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Start Date</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">End Date</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500 uppercase">Status</th>
              </tr>
            </thead>
            <tbody>
              {list.map((sem) => {
                const status = String(sem.status || '').toLowerCase();
                const badgeClass = status === 'active' ? 'bg-success' : 'bg-danger';
                return (
                  <tr key={sem.semester_id} className="border-t border-gray-100">
                    <td className="px-3 py-2 text-sm text-gray-700">{TERM_LABELS[String(sem.term || '').toLowerCase()] || sem.term}</td>
                    <td className="px-3 py-2 text-sm text-gray-700">{sem.start_date}</td>
                    <td className="px-3 py-2 text-sm text-gray-700">{sem.end_date}</td>
                    <td className="px-3 py-2 text-sm">
                      <span className={`badge ${badgeClass}`}>{status === 'active' ? 'Active' : 'Inactive'}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const columns = [
    { key: 'rownum', label: '#', render: (r, pIdx, gIdx) => gIdx + 1 },
    { key: 'session_name', label: 'School Year' },
    { key: 'start_date', label: 'Start Date' },
    { key: 'end_date', label: 'End Date' },
    {
      key: 'semester_count',
      label: 'Semesters',
      render: (row) => {
        const count = semesterCountBySession.get(Number(row.session_id)) || 0;
        const badgeClass = count >= 3 ? 'bg-success' : count > 0 ? 'bg-warning text-dark' : 'bg-secondary';
        return <span className={`badge ${badgeClass}`}>{count}/3</span>;
      },
    },
    {
      key: 'status',
      label: 'System Status',
      render: (row) => {
        const status = String(row.status || '').toLowerCase();
        return <span className={`mdp-status mdp-status-${status}`}>{status === 'active' ? 'Active' : status === 'archive' ? 'Archived' : 'Inactive'}</span>;
      },
    },
    {
      key: 'actions',
      label: 'Actions',
      actions: (row) => {
        if (String(row.status || '').toLowerCase() === 'archive') return [{ label: 'Restore', variant: 'success', onClick: () => handleRestore(row) }];
        const actions = [];
        const hasOperationalData = Number(row?.schedule_count || 0) > 0 || Number(row?.attendance_count || 0) > 0;
        if (!hasOperationalData) {
          actions.push({ label: 'Edit School Year', onClick: () => openModal(row) });
        } else {
          actions.push({
            label: 'School Year Edit Restricted',
            onClick: async () => {
              try {
                if (window.Swal) {
                  await window.Swal.fire({
                    icon: 'info',
                    title: 'Edit Restricted',
                    text: 'This school year already has schedules or attendance records. Date edits are restricted to protect finalized data.',
                  });
                }
              } catch (e) {}
            },
          });
        }
        if (!hasOperationalData) {
          actions.push({ label: 'Edit', onClick: () => openSemesterBatchModal(row) });
        } else {
          actions.push({ label: 'Semester Edit Restricted', onClick: showSemesterEditRestrictedAlert });
        }
        actions.push({ label: 'Archive Data', variant: 'danger', onClick: () => handleArchive(row) });
        return actions;
      },
    },
  ];
  const selectSchoolYearStatus = (status) => {
    setStatusFilter(status);
    setShowArchived(status === 'archive');
    setExpandedSessionId(null);
  };
  const schoolYearStatusCount = (status) => items.filter((item) => String(item.status || '').toLowerCase() === status).length;

  return (
    <div className="mdp-page">
      <MasterPageHeader title="School Years" description="Configure academic years and keep all three semester periods aligned." action={statusFilter !== 'archive' ? <button className="mdp-primary" onClick={() => openModal()}>+ Create School Year</button> : null} />
      <MasterStats loading={loading} items={[{ label: 'Active', value: schoolYearStatusCount('active'), help: 'Current operational periods', icon: '\u2713', active: statusFilter === 'active', onClick: () => selectSchoolYearStatus('active') }, { label: 'Inactive', value: schoolYearStatusCount('inactive'), help: 'Planned or unavailable periods', icon: 'I', tone: 'red', active: statusFilter === 'inactive', onClick: () => selectSchoolYearStatus('inactive') }, { label: 'Archived', value: schoolYearStatusCount('archive'), help: 'Available for restoration', icon: 'A', active: statusFilter === 'archive', onClick: () => selectSchoolYearStatus('archive') }]} />
      <MasterToolbar><MasterSearch value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search school year or date..." /><MasterSelect label="Status" value={statusFilter} onChange={(event) => selectSchoolYearStatus(event.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="archive">Archived</option></MasterSelect></MasterToolbar>
      <MasterResults title={statusFilter === 'archive' ? 'Archived School Years' : 'Academic Timeline'} count={filteredItems.length} loading={loading} description={statusFilter === 'archive' ? 'Restore an archived school year as inactive.' : 'Select a row to review its semester schedule.'}><Table columns={columns} data={filteredItems} loading={loading} pageSize={10} rowKey="session_id" onRowClick={statusFilter === 'archive' ? undefined : handleSchoolYearRowClick} expandedRowKey={statusFilter === 'archive' ? null : expandedSessionId} renderExpandedRow={statusFilter === 'archive' ? undefined : renderExpandedSemesterRow} /></MasterResults>

      <Modal show={showModal} title={editing ? 'Edit School Year' : 'Create School Year'} onClose={closeModal}>
        <form onSubmit={handleSubmit} className="space-y-4">
          {editing && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              School year dates are editable while planning. Once schedules or attendance exist, date edits are restricted and must still cover existing semester/attendance data.
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">School Year Name</label>
            <input
              name="session_name"
              value={form.session_name}
              onChange={handleChange}
              required
              placeholder="e.g. 2026-2027"
              className="block w-full border border-gray-200 rounded px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
            <input
              type="date"
              name="start_date"
              value={form.start_date}
              onChange={handleChange}
              required
              className="block w-full border border-gray-200 rounded px-3 py-2"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
            <input
              type="date"
              name="end_date"
              value={form.end_date}
              onChange={handleChange}
              required
              className="block w-full border border-gray-200 rounded px-3 py-2"
            />
          </div>

          <div className="flex justify-end gap-2 mt-4">
            <button type="button" onClick={closeModal} className="px-3 py-2 rounded border">Cancel</button>
            <button type="submit" disabled={loading} className="px-4 py-2 rounded bg-green-600 text-white">
              {loading ? 'Saving...' : (editing ? 'Save Changes' : 'Create School Year')}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        show={showSemesterBatchModal}
        title={semesterBatchTarget ? `Edit Semesters - ${semesterBatchTarget.session_name}` : 'Edit Semesters'}
        onClose={closeSemesterBatchModal}
        size="lg"
      >
        <form onSubmit={handleSemesterBatchSubmit} className="space-y-4">
          <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
            <div className="font-semibold text-gray-900">
              School Year: {semesterBatchTarget?.session_name || '-'} ({semesterBatchTarget?.start_date || '-'} to {semesterBatchTarget?.end_date || '-'})
            </div>
            <div className="mt-2 text-xs text-gray-600">
              Edit all three semester dates in one save. Dates must be inside the school year and should not overlap.
            </div>
          </div>

          {semesterBatchRows.map((row) => (
            <div key={row.term} className="grid grid-cols-1 md:grid-cols-3 gap-3 border border-gray-200 rounded-lg p-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Term</label>
                <input
                  type="text"
                  value={TERM_LABELS[row.term] || row.term}
                  disabled
                  className="block w-full border border-gray-200 bg-gray-100 rounded px-3 py-2 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
                <input
                  type="date"
                  value={row.start_date}
                  onChange={(e) => handleSemesterBatchRowChange(row.term, 'start_date', e.target.value)}
                  required
                  className="block w-full border border-gray-200 rounded px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
                <input
                  type="date"
                  value={row.end_date}
                  onChange={(e) => handleSemesterBatchRowChange(row.term, 'end_date', e.target.value)}
                  required
                  className="block w-full border border-gray-200 rounded px-3 py-2"
                />
              </div>
            </div>
          ))}

          <div className="flex justify-end gap-2 mt-4">
            <button type="button" onClick={closeSemesterBatchModal} className="px-3 py-2 rounded border">Cancel</button>
            <button type="submit" disabled={semesterSaving} className="px-4 py-2 rounded bg-green-600 text-white">
              {semesterSaving ? 'Saving...' : 'Save Semesters'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default SchoolYearIndex;

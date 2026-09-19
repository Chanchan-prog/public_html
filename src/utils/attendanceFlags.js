export function normalizeAttendanceFlagName(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const key = raw.toLowerCase();
  if (key === 'na' || key === 'n/a') return 'Upcoming';
  if (key === 'upcoming') return 'Upcoming';
  if (key === 'pending') return 'Pending';
  if (key === 'present') return 'Present';
  if (key === 'absent') return 'Absent';
  if (key === 'late') return 'Late';
  if (key === 'substituted') return 'Substituted';
  if (key === 'on leave' || key === 'on_leave') return 'On Leave';
  if (key === 'incomplete' || key === 'partial attendance' || key === 'partial_attendance') return 'Partial Attendance';
  return raw;
}

export function attendanceFlagLabel(flagId, flagName = '') {
  const named = normalizeAttendanceFlagName(flagName);
  if (named) return named;
  const id = Number(flagId);
  if (id === 1) return 'Upcoming';
  if (id === 2) return 'Present';
  if (id === 3) return 'Absent';
  if (id === 4) return 'Substituted';
  if (id === 5) return 'Late';
  if (id === 7) return 'On Leave';
  if (id === 8) return 'Pending';
  return flagId || '-';
}

export function attendanceFlagKey(flagId, flagName = '') {
  const label = String(attendanceFlagLabel(flagId, flagName)).trim().toLowerCase();
  if (label === 'upcoming' || label === 'na' || label === 'n/a') return 'upcoming';
  if (label === 'pending') return 'pending';
  if (label === 'present') return 'present';
  if (label === 'absent') return 'absent';
  if (label === 'late') return 'late';
  if (label === 'substituted') return 'substituted';
  if (label === 'on leave' || label === 'on_leave') return 'on_leave';
  if (label === 'incomplete' || label === 'partial attendance' || label === 'partial_attendance') return 'incomplete';
  return label.replace(/\s+/g, '_') || 'unknown';
}

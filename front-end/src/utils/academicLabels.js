export function formatAcademicLabel(subName, fullName, fallback = '') {
  const shortLabel = String(subName ?? '').trim();
  const fullLabel = String(fullName ?? '').trim();

  if (!shortLabel) return fullLabel || String(fallback ?? '').trim();
  if (!fullLabel || shortLabel.toLowerCase() === fullLabel.toLowerCase()) return shortLabel;
  return `${shortLabel} (${fullLabel})`;
}

export function formatDepartmentLabel(department, fallback = '') {
  return formatAcademicLabel(
    department?.sub_name ?? department?.department_sub_name ?? department?.dept_sub_name,
    department?.dept_name ?? department?.department_name ?? department?.department,
    fallback
  );
}

export function formatProgramLabel(program, fallback = '') {
  return formatAcademicLabel(
    program?.sub_name ?? program?.program_sub_name,
    program?.program_name ?? program?.assigned_program_name,
    fallback
  );
}

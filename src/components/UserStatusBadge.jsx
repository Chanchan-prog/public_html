import React from 'react';

export function normalizeUserStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (['archive', 'archived'].includes(value)) return 'archive';
  if (['inactive', 'disabled', '0', 'false'].includes(value)) return 'inactive';
  if (['active', '1', 'true'].includes(value)) return 'active';
  return value;
}

export default function UserStatusBadge({ status, showActive = false, className = '' }) {
  const normalized = normalizeUserStatus(status);
  if (!normalized || (normalized === 'active' && !showActive)) return null;

  const archived = normalized === 'archive';
  const inactive = normalized === 'inactive';
  const label = archived ? 'Archived' : inactive ? 'Inactive' : normalized;
  const tone = archived
    ? 'border-slate-300 bg-slate-100 text-slate-700'
    : inactive
      ? 'border-amber-200 bg-amber-50 text-amber-800'
      : 'border-emerald-200 bg-emerald-50 text-emerald-700';

  return (
    <span
      className={`inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${tone} ${className}`.trim()}
      title={`Account status: ${label}`}
    >
      {label}
    </span>
  );
}

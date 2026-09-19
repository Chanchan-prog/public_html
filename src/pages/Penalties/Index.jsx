import React from 'react';
import { AuthContext } from '../../context/AuthContext.jsx';
import { apiGet, apiPost, apiPut } from '../../services/api.js';
import Table from '../../components/Table.jsx';
import Modal from '../../components/Modal.jsx';
import UserStatusBadge from '../../components/UserStatusBadge.jsx';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';

const TEACHING_ROLE_LABELS = {
  2: 'Dean',
  3: 'Program Head',
  4: 'Secretary',
  5: 'Teacher',
};

const today = () => new Date().toISOString().slice(0, 10);
const emptyForm = () => ({ user_id: '', penal_type_id: '', date: today(), reason: '' });

const badge = (text, tone = 'gray') => {
  const tones = {
    red: 'bg-red-50 text-red-700 border-red-200',
    amber: 'bg-amber-50 text-amber-700 border-amber-200',
    green: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    blue: 'bg-blue-50 text-blue-700 border-blue-200',
    gray: 'bg-gray-50 text-gray-600 border-gray-200',
  };
  return <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>{text}</span>;
};

export default function PenaltiesPage() {
  const { user } = React.useContext(AuthContext);
  const currentRoleId = Number(user?.role_id || 0);
  const canManagePenalties = [2, 6].includes(currentRoleId);
  const [rows, setRows] = React.useState([]);
  const [staff, setStaff] = React.useState([]);
  const [penaltyTypes, setPenaltyTypes] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [showModal, setShowModal] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [form, setForm] = React.useState(emptyForm);
  const [search, setSearch] = React.useState('');
  const [roleFilter, setRoleFilter] = React.useState('all');
  const [sourceFilter, setSourceFilter] = React.useState('all');
  const [statusFilter, setStatusFilter] = React.useState('all');
  const [page, setPage] = React.useState(1);
  const [pagination, setPagination] = React.useState({ page: 1, page_size: 10, total: 0, total_pages: 1 });
  const [summary, setSummary] = React.useState({ total: 0, active: 0, automatic: 0, manual: 0 });
  const [debouncedSearch, setDebouncedSearch] = React.useState('');

  React.useEffect(() => {
    if (user && ![2, 3, 4, 6].includes(Number(user.role_id))) window.location.hash = '#/dashboard';
  }, [user]);

  React.useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  React.useEffect(() => { setPage(1); }, [debouncedSearch, roleFilter, sourceFilter, statusFilter]);

  const fetchRows = React.useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const params = new URLSearchParams({ paginate: '1', page: String(page), page_size: '10' });
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (roleFilter !== 'all') params.set('role_id', roleFilter);
      if (sourceFilter !== 'all') params.set('source', sourceFilter);
      if (statusFilter !== 'all') params.set('status', statusFilter);
      const penaltiesRes = await apiGet(`penalties?${params.toString()}`).catch(() => null);
      setRows(Array.isArray(penaltiesRes?.rows) ? penaltiesRes.rows : (Array.isArray(penaltiesRes) ? penaltiesRes : []));
      if (penaltiesRes?.pagination) {
        setPagination(penaltiesRes.pagination);
        if (Number(penaltiesRes.pagination.page || 1) !== page) setPage(Number(penaltiesRes.pagination.page || 1));
      }
      if (penaltiesRes?.summary) setSummary({
        total: Number(penaltiesRes.summary.total || 0),
        active: Number(penaltiesRes.summary.active || 0),
        automatic: Number(penaltiesRes.summary.automatic || 0),
        manual: Number(penaltiesRes.summary.manual || 0),
      });
    } catch (error) {
      console.error(error);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [page, debouncedSearch, roleFilter, sourceFilter, statusFilter]);

  const loadOptions = React.useCallback(async () => {
    try {
      const [staffRes, typesRes] = await Promise.all([
        apiGet('users?list=1&teaching_roles=1').catch(() => []),
        apiGet('penalty-types').catch(() => []),
      ]);
      setStaff((Array.isArray(staffRes) ? staffRes : [])
        .filter((entry) => [2, 3, 4, 5].includes(Number(entry.role_id)))
        .filter((entry) => currentRoleId === 6 || Number(entry.role_id) !== 2)
        .sort((a, b) => `${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`)));
      setPenaltyTypes(Array.isArray(typesRes) ? typesRes : []);
    } catch (error) {
      console.error(error);
    }
  }, [currentRoleId]);

  React.useEffect(() => {
    if (user) loadOptions();
  }, [user, loadOptions]);

  React.useEffect(() => {
    if (user) fetchRows();
  }, [user, fetchRows]);

  useAutoRefresh({
    refresh: () => fetchRows({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.HEAVY,
    enabled: Boolean(user) && !showModal,
  });

  const filteredRows = rows;

  const modalStaff = React.useMemo(() => {
    if (!editing || staff.some((entry) => Number(entry.user_id) === Number(editing.user_id))) return staff;
    return [{
      user_id: editing.user_id,
      first_name: editing.first_name || '',
      last_name: editing.last_name || '',
      role_id: editing.role_id,
    }, ...staff];
  }, [staff, editing]);

  const openModal = (row = null) => {
    if (!canManagePenalties) return;
    if (row && currentRoleId === 2 && Number(row.role_id) === 2) return;
    if (row && !['active', '1', 'true'].includes(String(row.user_status || '').trim().toLowerCase())) {
      if (window.Swal) window.Swal.fire('Read-only record', 'Activate this user before editing their penalty record.', 'info');
      return;
    }
    setEditing(row);
    setForm(row ? {
      user_id: String(row.user_id || ''),
      penal_type_id: String(row.penal_type_id || ''),
      date: row.date || today(),
      reason: row.reason || '',
    } : emptyForm());
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditing(null);
    setForm(emptyForm());
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!canManagePenalties) return;
    if (!form.user_id || !form.penal_type_id || !form.date) {
      if (window.Swal) window.Swal.fire('Missing information', 'Select teaching staff, penalty type, and date.', 'warning');
      return;
    }
    try {
      const payload = {
        user_id: Number(form.user_id),
        penal_type_id: Number(form.penal_type_id),
        date: form.date,
        reason: form.reason.trim(),
      };
      const target = modalStaff.find(user => String(user.user_id) === String(form.user_id));
      const targetName = target ? `${target.first_name || ''} ${target.last_name || ''}`.trim() : 'the selected user';
      const confirmation = window.Swal ? await window.Swal.fire({ title: editing?.sanction_id ? 'Update Penalty?' : 'Add Manual Penalty?', text: `${targetName} will receive this penalty dated ${form.date}.`, icon:'warning', showCancelButton:true, confirmButtonText:'Save Penalty', confirmButtonColor:'#198754' }) : { isConfirmed:confirm(`Save this penalty for ${targetName}?`) };
      if (!confirmation.isConfirmed) return;
      if (editing?.sanction_id) await apiPut(`penalties/${editing.sanction_id}`, payload);
      else await apiPost('penalties', payload);
      closeModal();
      await fetchRows();
      if (window.Swal) window.Swal.fire('Saved', 'Penalty record saved successfully.', 'success');
    } catch (error) {
      console.error(error);
      const message = error?.body?.message || error?.message || 'Failed to save the penalty.';
      if (window.Swal) window.Swal.fire('Unable to save', message, 'error');
    }
  };

  const columns = [
    { key: 'date', label: 'Date' },
    {
      key: 'staff', label: 'Teaching Staff', render: (row) => (
        <div>
          <div className="font-semibold text-gray-900">{`${row.last_name || ''}, ${row.first_name || ''}`.replace(/^,\s*/, '') || 'Unknown user'}</div>
          <UserStatusBadge status={row.user_status} className="mt-1" />
          <div className="mt-1 text-xs text-gray-500">{TEACHING_ROLE_LABELS[Number(row.role_id)] || 'Teaching Staff'}{row.dept_name ? ` · ${row.dept_name}` : ''}</div>
        </div>
      ),
    },
    { key: 'type_name', label: 'Penalty Type', render: (row) => <span className="font-medium text-gray-800">{row.type_name || 'Penalty'}</span> },
    { key: 'source', label: 'Source', render: (row) => String(row.source).toLowerCase() === 'automatic' ? badge('Automatic', 'blue') : badge('Manual', 'gray') },
    { key: 'status', label: 'Status', render: (row) => String(row.status).toLowerCase() === 'voided' ? badge('Voided', 'gray') : badge('Active', 'red') },
    {
      key: 'reason', label: 'Reason / Remarks', render: (row) => (
        <div className="max-w-md whitespace-normal text-sm leading-5 text-gray-600" title={row.reason || ''}>{row.reason || '—'}</div>
      ),
    },
    ...(canManagePenalties ? [{
      key: 'actions', label: 'Actions', render: (row) => (
        currentRoleId === 6 || Number(row.role_id) !== 2 ? (
          <button type="button" onClick={() => openModal(row)} disabled={!['active', '1', 'true'].includes(String(row.user_status || '').trim().toLowerCase())} title={!['active', '1', 'true'].includes(String(row.user_status || '').trim().toLowerCase()) ? 'Inactive users are read-only' : 'Edit penalty'} className="inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm font-semibold text-gray-700 shadow-sm transition hover:border-emerald-300 hover:text-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
            <i className="bi bi-pencil-square" /> Edit
          </button>
        ) : null
      ),
    }] : []),
  ];

  const filterClass = 'h-10 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100';

  return (
    <div className="min-h-full bg-gray-50/70 px-4 py-5 md:px-6">
      <div className="mx-auto max-w-[1450px] space-y-4">
        <div className="flex flex-col gap-4 rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-lg text-emerald-700"><i className="bi bi-shield-exclamation" /></div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-gray-900">Penalties &amp; Sanctions</h1>
              <p className="mt-0.5 text-sm text-gray-500">Manual sanctions and automatic tardiness red flags for teaching staff.</p>
            </div>
          </div>
          {canManagePenalties && (
            <button type="button" onClick={() => openModal()} className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800">
              <i className="bi bi-plus-circle" /> Add Manual Penalty
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            ['Total Records', summary.total, 'bi-journal-text', 'text-gray-600', 'bg-gray-50'],
            ['Active', summary.active, 'bi-exclamation-octagon', 'text-red-600', 'bg-red-50'],
            ['Automatic', summary.automatic, 'bi-lightning-charge', 'text-blue-600', 'bg-blue-50'],
            ['Manual', summary.manual, 'bi-person-check', 'text-amber-600', 'bg-amber-50'],
          ].map(([label, value, icon, color, iconBg]) => (
            <div key={label} className="flex min-h-[78px] items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 shadow-sm">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${iconBg} ${color}`}><i className={`bi ${icon}`} /></div>
              <div><div className="text-xl font-bold leading-none text-gray-900">{value}</div><div className="mt-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</div></div>
            </div>
          ))}
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <i className="bi bi-info-circle-fill mt-0.5" />
          <span>Penalty records are for notification, reporting, and administrative review. They do not block attendance scanning, disable accounts, or automatically deduct salary.</span>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm md:p-5">
          <div className="mb-4 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <h2 className="text-lg font-bold text-gray-900">Penalty records</h2>
              <p className="text-sm text-gray-500">Showing {filteredRows.length} of {Number(pagination.total || 0)} matching records</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:flex">
              <div className="relative sm:col-span-2 xl:w-72">
                <i className="bi bi-search absolute left-3 top-2.5 text-gray-400" />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search staff, type, or reason" className={`${filterClass} w-full pl-9`} />
              </div>
              <select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)} className={filterClass} aria-label="Filter by role">
                <option value="all">All teaching roles</option>
                {Object.entries(TEACHING_ROLE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
              <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} className={filterClass} aria-label="Filter by source">
                <option value="all">All sources</option><option value="automatic">Automatic</option><option value="manual">Manual</option>
              </select>
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className={filterClass} aria-label="Filter by status">
                <option value="all">All statuses</option><option value="active">Active</option><option value="voided">Voided</option>
              </select>
            </div>
          </div>
          <Table columns={columns} data={filteredRows} pageSize={10} loading={loading} emptyText="No penalty records match the selected filters." rowKey="sanction_id" wrapCells serverPagination totalItems={Number(pagination.total || 0)} page={page} onPageChange={setPage} />
        </div>
      </div>

      <Modal show={showModal && canManagePenalties} title={editing ? 'Edit Penalty' : 'Add Manual Penalty'} onClose={closeModal} size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          {editing?.source === 'automatic' && (
            <div className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-sm text-blue-800"><i className="bi bi-lightning-charge-fill mr-2" />This record was created by the three-warning tardiness policy.</div>
          )}
          <div>
            <label className="mb-1.5 block text-sm font-semibold text-gray-700">Teaching staff</label>
            <select required value={form.user_id} onChange={(event) => setForm((state) => ({ ...state, user_id: event.target.value }))} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100">
              <option value="">{modalStaff.length ? 'Select teaching staff' : 'No eligible teaching staff found'}</option>
              {modalStaff.map((entry) => <option key={entry.user_id} value={entry.user_id}>{entry.last_name}, {entry.first_name} — {TEACHING_ROLE_LABELS[Number(entry.role_id)]}</option>)}
            </select>
            <p className="mt-1 text-xs text-gray-500">{currentRoleId === 6 ? 'Active Dean, Program Head, Secretary, or Teacher accounts.' : 'Active Program Head, Secretary, or Teacher accounts. Dean penalties are managed by the Department Admin.'}</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-700">Penalty type</label>
              <select required value={form.penal_type_id} onChange={(event) => setForm((state) => ({ ...state, penal_type_id: event.target.value }))} className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2.5 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100">
                <option value="">Select type</option>
                {penaltyTypes.map((type) => <option key={type.penal_type_id} value={type.penal_type_id}>{type.type_name}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-semibold text-gray-700">Date</label>
              <input type="date" required value={form.date} onChange={(event) => setForm((state) => ({ ...state, date: event.target.value }))} className="w-full rounded-xl border border-gray-200 px-3 py-2.5 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-semibold text-gray-700">Reason / remarks</label>
            <textarea rows="4" value={form.reason} onChange={(event) => setForm((state) => ({ ...state, reason: event.target.value }))} className="w-full resize-y rounded-xl border border-gray-200 px-3 py-2.5 outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-100" placeholder="Describe the basis of this penalty." />
          </div>
          <div className="flex justify-end gap-2 border-t border-gray-100 pt-4">
            <button type="button" onClick={closeModal} className="rounded-xl border border-gray-200 px-4 py-2.5 text-sm font-semibold text-gray-700 hover:bg-gray-50">Cancel</button>
            <button type="submit" className="rounded-xl bg-emerald-700 px-5 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-emerald-800">Save Penalty</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

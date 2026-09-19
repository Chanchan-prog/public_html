import React from 'react';
import { apiGet, apiPut } from '../../services/api.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import LoadingState from '../../components/LoadingState.jsx';

export function SecurityPolicyPanel() {
  const [policy,setPolicy]=React.useState(null); const [limits,setLimits]=React.useState({}); const [saving,setSaving]=React.useState(false); const [message,setMessage]=React.useState('');
  const load=React.useCallback(async()=>{const data=await apiGet('admin-settings/security-policy');setPolicy(data.policy);setLimits(data.limits||{});},[]);
  React.useEffect(()=>{load().catch(e=>setMessage(e.message));},[load]);
  useAutoRefresh({refresh:load,intervalMs:AUTO_REFRESH_INTERVALS.ADMIN,enabled:!saving});
  const set=(key,value)=>setPolicy(prev=>({...prev,[key]:value}));
  const save=async()=>{
    const confirmation = window.Swal ? await window.Swal.fire({ title:'Save Security Policy?', text:'These login, session, and password rules will be enforced for the system.', icon:'warning', showCancelButton:true, confirmButtonText:'Save Security Policy', confirmButtonColor:'#198754' }) : { isConfirmed:window.confirm('Save and enforce this security policy?') };
    if (!confirmation.isConfirmed) return;
    setSaving(true);setMessage('');
    try{const data=await apiPut('admin-settings/security-policy',policy);setPolicy(data.policy);setMessage('Security policy saved and is now enforced by PHP.');}
    catch(e){setMessage(e?.body?.message||e.message);}
    finally{setSaving(false);}
  };
  if(!policy)return <div className="card border-0 shadow-sm"><div className="card-body"><LoadingState label="Loading security policy..." /></div></div>;
  const numbers=[['max_login_attempts','Maximum login attempts'],['lock_duration_seconds','Lock duration (seconds)'],['idle_timeout_minutes','Idle timeout (minutes)'],['absolute_session_minutes','Absolute session duration (minutes)'],['password_expiry_days','Password expiration (days)'],['password_min_length','Minimum password length']];
  return <div className="card border-0 shadow-sm gs-control-card"><div className="card-body p-4"><h5 className="fw-bold mb-1">Security Policy Rules</h5><p className="text-muted">These values are validated and enforced by the server.</p>{message&&<div className="alert alert-info">{message}</div>}<div className="row g-3">{numbers.map(([key,label])=><div className="col-12 col-md-6" key={key}><label className="form-label fw-semibold">{label}</label><input type="number" className="form-control" min={limits[key]?.[0]} max={limits[key]?.[1]} value={policy[key]} onChange={e=>set(key,Number(e.target.value))}/></div>)}</div><div className="d-flex flex-wrap gap-3 mt-4">{[['password_require_letter','Require a letter'],['password_require_number','Require a number'],['password_require_special','Require a special character']].map(([key,label])=><label className="form-check" key={key}><input className="form-check-input" type="checkbox" checked={Boolean(Number(policy[key]))} onChange={e=>set(key,e.target.checked?1:0)}/><span className="form-check-label">{label}</span></label>)}</div><button className="btn btn-success mt-4" disabled={saving} onClick={save}>{saving?'Saving...':'Save Security Policy'}</button></div></div>;
}

const activityPageNumbers = (page, totalPages) => {
  const start = Math.max(1, Math.min(page - 2, totalPages - 4));
  const end = Math.min(totalPages, start + 4);
  return Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
};

export function SettingsActivityPanel() {
  const [rows, setRows] = React.useState([]);
  const [error, setError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [page, setPage] = React.useState(1);
  const [pagination, setPagination] = React.useState({ page: 1, page_size: 10, total: 0, total_pages: 1 });
  const requestRef = React.useRef(0);

  const load = React.useCallback(async ({ silent = false } = {}) => {
    const requestId = ++requestRef.current;
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try {
      const data = await apiGet(`admin-settings/activity?page=${page}&page_size=10`);
      if (requestId !== requestRef.current) return;
      setRows(Array.isArray(data?.rows) ? data.rows : []);
      const nextPagination = data?.pagination || { page, page_size: 10, total: 0, total_pages: 1 };
      setPagination(nextPagination);
      if (Number(nextPagination.page) !== page) setPage(Number(nextPagination.page) || 1);
    } catch (loadError) {
      if (requestId !== requestRef.current) return;
      if (!silent) setError(loadError?.body?.message || loadError.message || 'Failed to load settings activity.');
    } finally {
      if (!silent && requestId === requestRef.current) setLoading(false);
    }
  }, [page]);

  React.useEffect(() => { load(); }, [load]);
  useAutoRefresh({ refresh: () => load({ silent: true }), intervalMs: AUTO_REFRESH_INTERVALS.HEAVY });

  const currentPage = Math.max(1, Number(pagination.page || page));
  const totalPages = Math.max(1, Number(pagination.total_pages || 1));
  const total = Math.max(0, Number(pagination.total || 0));
  const first = total ? ((currentPage - 1) * 10) + 1 : 0;
  const last = total ? Math.min(total, currentPage * 10) : 0;

  return (
    <div className="card border-0 shadow-sm">
      <div className="card-body p-4 pb-0">
        <h5 className="fw-bold">Settings Activity</h5>
        <p className="text-muted">Security-sensitive administration actions. Passwords, tokens, and secrets are never displayed.</p>
        {error && <div className="alert alert-danger">{error}</div>}
      </div>
      {loading ? (
        <LoadingState label="Loading settings activity..." />
      ) : (
        <div className="table-responsive">
          <table className="table table-hover align-middle mb-0">
            <thead><tr><th className="ps-4">Time</th><th>Administrator</th><th>Action</th><th>Details</th><th className="pe-4">IP</th></tr></thead>
            <tbody>{rows.map(r=><tr key={r.log_id}><td className="small text-muted ps-4">{new Date(r.timestamp).toLocaleString()}</td><td>{r.actor_name?.trim()||'-'}</td><td><span className="badge bg-success bg-opacity-10 text-success">{String(r.action).replace(/_/g,' ')}</span></td><td>{r.details}</td><td className="font-monospace small pe-4">{r.ip_address||'-'}</td></tr>)}</tbody>
          </table>
          {!rows.length && <div className="text-center text-muted py-4">No settings activity recorded.</div>}
        </div>
      )}
      {!loading && (
        <div className="d-flex flex-wrap justify-content-between align-items-center gap-2 border-top px-3 px-md-4 py-3">
          <small className="text-muted">Showing {first}-{last} of {total} activity record(s)</small>
          <nav aria-label="Settings activity pages">
            <ul className="pagination pagination-sm mb-0">
              <li className={`page-item ${currentPage <= 1 ? 'disabled' : ''}`}><button type="button" className="page-link" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous</button></li>
              {activityPageNumbers(currentPage, totalPages).map(pageNumber => <li key={pageNumber} className={`page-item ${pageNumber === currentPage ? 'active' : ''}`}><button type="button" className="page-link" aria-current={pageNumber === currentPage ? 'page' : undefined} onClick={() => setPage(pageNumber)}>{pageNumber}</button></li>)}
              <li className={`page-item ${currentPage >= totalPages ? 'disabled' : ''}`}><button type="button" className="page-link" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>Next</button></li>
            </ul>
          </nav>
        </div>
      )}
    </div>
  );
}

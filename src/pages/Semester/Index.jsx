import React from 'react';
import { apiGet, apiPost, apiPut } from '../../services/api.js';
import Table from "../../components/Table.jsx";
import Modal from "../../components/Modal.jsx";
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';

function getApiErrorMessage(err, fallbackMessage) {
  const body = err?.body;
  if (body && typeof body === 'object') {
    if (body.message && String(body.message).trim()) return String(body.message).trim();
    const code = String(body.error || '').toLowerCase();
    if (code === 'semester_date_conflict') return 'The semester dates overlap another semester. Please choose a non-conflicting date range.';
    if (code === 'semester_outside_school_year') return 'Semester dates must stay within the school year range.';
    if (code === 'semester_restricted') return 'This semester already has schedules or attendance records. Date edits are restricted.';
    if (code) return code.replace(/_/g, ' ');
  }
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (err?.message && String(err.message).trim()) {
    const msg = String(err.message).trim();
    if (/Network request failed/i.test(msg)) return 'Unable to complete the request right now. Please check your connection and try again.';
    return msg;
  }
  return fallbackMessage;
}

function SemesterIndex(){
  const [items, setItems] = React.useState([]);
  const [showModal, setShowModal] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [form, setForm] = React.useState({ session_name: '', term: '', start_date: '', end_date: '' });
  const [loading, setLoading] = React.useState(true);

  const runWithFallback = async (primary, fallback) => {
    try { return await primary(); } catch (err) { if (err?.status === 405 || err?.status === 500) return await fallback(); throw err; }
  };

  const loadData = React.useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const data = await apiGet('semesters');
      setItems(Array.isArray(data)? data.filter(x => String(x.status||'').toLowerCase() !== 'archive') : []);
    } catch(e) { console.error(e); }
    finally { if (!silent) setLoading(false); }
  }, []);

  React.useEffect(()=>{ loadData(); }, [loadData]);

  useAutoRefresh({
    refresh: () => loadData({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.ADMIN,
    enabled: !showModal,
  });

  const openModal = (it)=>{
    setEditing(it);
    setForm({ session_name: it.session_name||'', term: it.term||'', start_date: it.start_date||'', end_date: it.end_date||'' });
    setShowModal(true);
  };
  
  const closeModal = ()=> setShowModal(false);
  const handleChange = (e)=> setForm(p=>({...p, [e.target.name]: e.target.value}));

  const handleSubmit = async (e)=>{ 
    e.preventDefault(); setLoading(true); 
    if (new Date(form.start_date) > new Date(form.end_date)) {
        try { if (window.Swal) await window.Swal.fire({ icon:'warning', title:'Invalid Date Range', text: 'Please set the start date earlier than or equal to the end date.' }); } catch(e){} setLoading(false); return;
    }
    try{
      const payload = { start_date: form.start_date, end_date: form.end_date };
      await runWithFallback(() => apiPut(`semesters/${editing.semester_id}`, payload), () => apiPost(`semesters/${editing.semester_id}/update`, payload));
      
      const data = await apiGet('semesters');
      setItems(Array.isArray(data)? data.filter(x => String(x.status||'').toLowerCase() !== 'archive') : []);
      closeModal();
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Semester Updated Successfully', text:'Semester dates were saved.', timer:1700, showConfirmButton:false }); } catch(e){}
    }catch(err){ 
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Unable to Update Semester', text: getApiErrorMessage(err, 'We could not update semester dates right now.') }); } catch(e){} 
    } finally{ setLoading(false); } 
  };

  const handleArchive = async (it) => {
    try {
        const res = window.Swal 
            ? await window.Swal.fire({ 
                title: 'Archive Semester?', 
                text: 'This will move the semester to the archive database and remove it from the active list.', 
                icon: 'warning', 
                showCancelButton: true 
              }) 
            : { isConfirmed: confirm('Archive semester?') };
        if (!res.isConfirmed) return;
        
        await runWithFallback(() => apiPut(`semesters/${it.semester_id}`, { status: 'archive' }), () => apiPost(`semesters/${it.semester_id}/update`, { status: 'archive' }));
        
        const data = await apiGet('semesters'); 
        setItems(Array.isArray(data)? data.filter(x => String(x.status||'').toLowerCase() !== 'archive') : []);
        
        try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Semester Archived', text:'The semester was moved to archive successfully.', timer:1700, showConfirmButton:false }); } catch(e){}
    } catch (err) { 
        try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Archive Blocked', text: getApiErrorMessage(err, 'Archive failed. Please ensure related class data is archived first.') }); } catch(e){} 
    }
  };

  const showEditRestrictedAlert = async () => {
    try {
      if (window.Swal) {
        await window.Swal.fire({
          icon: 'info',
          title: 'Edit Restricted',
          text: 'This semester already has schedules or attendance records. Date edits are not allowed.',
        });
      }
    } catch (e) {}
  };

  const columns = [
    { key: 'rownum', label: '#', render: (r, pIdx, gIdx) => gIdx + 1 },
    { key: 'session_name', label: 'School Year' },
    { key: 'term', label: 'Term' },
    { key: 'start_date', label: 'Start Date' },
    { key: 'end_date', label: 'End Date' },
    { key: 'status', label: 'System Status', render: (r) => {
      const s = (r.status || '').toLowerCase();
      const cls = s === 'active' ? 'bg-success' : 'bg-danger';
      return (<span className={`badge ${cls}`}>{s === 'active' ? 'Active' : 'Inactive'}</span>);
    }},
    { key: 'actions', label: 'Actions', actions: (row) => {
      const hasOperationalData = Number(row?.schedule_count || 0) > 0 || Number(row?.attendance_count || 0) > 0;
      const actions = [];
      if (!hasOperationalData) {
        actions.push({ label: 'Edit Dates', onClick: () => openModal(row) });
      } else {
        actions.push({ label: 'Edit Restricted', onClick: showEditRestrictedAlert });
      }
      actions.push({ label: 'Archive Data', variant: 'danger', onClick: () => handleArchive(row) });
      return actions;
    }}
  ];

  return (
    <div style={{padding:20}}>
      <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12}}>
        <h2 style={{margin:0}}>Semesters Setup</h2>
      </div>
      <Table columns={columns} data={items} loading={loading} pageSize={10} />

      <Modal show={showModal} title="Edit Semester Dates" onClose={closeModal}>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">School Year (Locked)</label>
            <input type="text" value={form.session_name} disabled className="block w-full border border-gray-200 bg-gray-100 rounded px-3 py-2 cursor-not-allowed" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Term Name (Locked)</label>
            <input type="text" value={form.term} disabled className="block w-full border border-gray-200 bg-gray-100 rounded px-3 py-2 cursor-not-allowed" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Start Date</label>
            <input type="date" name="start_date" value={form.start_date} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">End Date</label>
            <input type="date" name="end_date" value={form.end_date} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2" />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeModal} className="px-3 py-2 rounded border">Cancel</button>
            <button type="submit" disabled={loading} className="px-4 py-2 rounded bg-green-600 text-white">{loading ? 'Saving...' : 'Save Dates'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default SemesterIndex;

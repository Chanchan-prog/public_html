import Table from "../../components/Table.jsx";
import Modal from "../../components/Modal.jsx";
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';

function SchoolIndex(){
  const [schools, setSchools] = React.useState([]);
  const [showModal, setShowModal] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [form, setForm] = React.useState({ school_name: '', address: '' });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [showArchived, setShowArchived] = React.useState(false);

  const runWithFallback = async (primary, fallback) => {
    try { return await primary(); } catch (err) { if (err?.status === 405 || err?.status === 500) return await fallback(); throw err; }
  };

  const loadData = React.useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try{
      const s = await apiGet('school');
      setSchools(Array.isArray(s) ? s : []);
    }catch(e){ console.error(e); if (!silent) setError('Failed to load schools'); }
    finally { if (!silent) setLoading(false); }
  }, []);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  useAutoRefresh({
    refresh: () => loadData({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.ADMIN,
    enabled: !showModal,
  });

  const openModal = (sch=null) => {
    setError('');
    if (sch) { setEditing(sch); setForm({ school_name: sch.school_name || '', address: sch.address || '' }); }
    else { setEditing(null); setForm({ school_name:'', address:'' }); }
    setShowModal(true);
  };
  const closeModal = ()=> setShowModal(false);
  const handleChange = (e)=> setForm(p=>({...p, [e.target.name]: e.target.value}));

  const validateForm = ()=>{
    const name = (form.school_name||'').trim();
    if (!name) return 'School name is required';
    const conflict = schools.find(s => s.school_name && String(s.school_name).toLowerCase() === name.toLowerCase() && (!editing || Number(s.school_id) !== Number(editing.school_id)));
    if (conflict) return 'A school with the same name already exists';
    return null;
  };

  const handleSubmit = async (e)=>{
    e.preventDefault(); setLoading(true); setError('');
    const v = validateForm();
    if (v) { try { if (window.Swal) await window.Swal.fire({ icon:'warning', title:'Validation', text: v }); else alert(v); } catch(e){} setLoading(false); return; }
    try{
      const payload = { school_name: form.school_name.trim(), address: form.address.trim() };
      if (editing && editing.school_id) {
        await runWithFallback(
          () => apiPut(`school/${editing.school_id}`, payload),
          () => apiPost(`school/${editing.school_id}/update`, payload)
        );
      } else {
        await apiPost('school', payload);
      }
      const s = await apiGet('school');
      setSchools(Array.isArray(s) ? s : []);
      closeModal();
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: editing ? 'School updated' : 'School added', timer:1400, showConfirmButton:false }); } catch(e){}
    } catch (err) {
      console.error(err);
      const msg = err?.body?.message || err?.body?.error || err?.message || 'Failed to save';
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: msg }); else alert(msg); } catch(e){}
      setError(msg);
    } finally { setLoading(false); }
  };

  const handleToggle = async (sch)=>{
    if (!sch || !sch.school_id) return;
    const newStatus = String(sch.status) === 'active' ? 'inactive' : 'active';
    try{
      await runWithFallback(
        () => apiPut(`school/${sch.school_id}`, { status: newStatus }),
        () => apiPost(`school/${sch.school_id}/update`, { status: newStatus })
      );
      const s = await apiGet('school'); setSchools(Array.isArray(s) ? s : []);
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Status updated', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) { console.error(err); try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.error || err.message || 'Failed to update status' }); else alert(err.body?.error || err.message || 'Failed to update status'); } catch(e){} }
  };

  const handleArchive = async (sch)=>{
    if (!sch || !sch.school_id) return;
    try{
      const res = window.Swal ? await window.Swal.fire({ title: 'Archive school?', text: 'This will remove the school from the active list.', icon: 'warning', showCancelButton: true }) : { isConfirmed: confirm('Archive school?') };
      if (!res.isConfirmed) return;
      await runWithFallback(
        () => apiPut(`school/${sch.school_id}`, { status: 'archive' }),
        () => apiPost(`school/${sch.school_id}/update`, { status: 'archive' })
      );
      const s = await apiGet('school'); setSchools(Array.isArray(s) ? s : []);
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Archived', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) { console.error(err); try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.error || err.message || 'Failed to archive' }); else alert(err.body?.error || err.message || 'Failed to archive'); } catch(e){} }
  };

  const handleRestore = async (sch) => {
    if (!sch?.school_id) return;
    const res = window.Swal ? await window.Swal.fire({ title:'Restore school?', text:'The school will be restored as inactive so you can review it before activation.', icon:'question', showCancelButton:true }) : { isConfirmed: confirm('Restore school?') };
    if (!res.isConfirmed) return;
    try {
      await runWithFallback(
        () => apiPut(`school/${sch.school_id}`, { status:'inactive' }),
        () => apiPost(`school/${sch.school_id}/update`, { status:'inactive' })
      );
      await loadData();
      if (window.Swal) await window.Swal.fire({ icon:'success', title:'School restored', timer:1200, showConfirmButton:false });
    } catch (err) {
      const msg = err?.body?.message || err?.body?.error || err?.message || 'Failed to restore school';
      if (window.Swal) await window.Swal.fire({ icon:'error', title:'Restore failed', text:msg });
    }
  };

  const columns = [
    { key:'rownum', label:'#', render: (r,pIdx,gIdx)=> gIdx + 1 },
    { key:'school_name', label:'School' },
    { key:'address', label:'Address' },
    { key:'status', label:'Status', render: (r)=>{
      const s = (r.status||'').toLowerCase();
      const cls = s === 'active' ? 'bg-success' : (s === 'inactive' ? 'bg-danger' : 'bg-secondary');
      const text = s === 'active' ? 'Active' : (s === 'inactive' ? 'Inactive' : (r.status || 'N/A'));
      return (<span className={`badge ${cls}`}>{text}</span>);
    }},
    { key:'actions', label:'Actions', actions: (row) => String(row.status || '').toLowerCase() === 'archive'
      ? [{ label:'Restore', variant:'success', onClick: () => handleRestore(row) }]
      : [{ label:'Edit', onClick: () => openModal(row) }, { label:'Toggle', onClick: () => handleToggle(row) }, { label:'Archive', variant:'danger', onClick: () => handleArchive(row) }]
    }
  ];

  const displayedSchools = schools.filter((school) => (String(school.status || '').toLowerCase() === 'archive') === showArchived);

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-semibold">Schools</h2>
        <div className="flex gap-2">
          <button className="btn btn-success" onClick={()=>openModal()}>Add School</button>
          <button className="btn btn-outline-secondary" onClick={() => setShowArchived(value => !value)}>{showArchived ? 'Show Current' : 'View Archive'}</button>
        </div>
      </div>

      {error && <div className="mb-3 text-red-600">{error}</div>}

      <Table columns={columns} data={displayedSchools} loading={loading} pageSize={10} />

      <Modal show={showModal} title={editing ? 'Edit School' : 'Add School'} onClose={closeModal} size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">School Name</label>
            <input name="school_name" value={form.school_name} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
            <input name="address" value={form.address} onChange={handleChange} className="block w-full border border-gray-200 rounded px-3 py-2" />
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeModal} className="px-3 py-2 rounded border">Cancel</button>
            <button type="submit" disabled={loading} className="px-4 py-2 rounded bg-green-600 text-white">{loading ? 'Saving...' : (editing ? 'Update School' : 'Save School')}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default SchoolIndex;


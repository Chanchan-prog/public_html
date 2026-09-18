import React from 'react';
import { apiGet, apiPost, apiPut } from '../../services/api.js';
import { AuthContext } from '../../context/AuthContext.jsx';
import Table from "../../components/Table.jsx";
import Modal from "../../components/Modal.jsx";
import QrModal from "../../components/QrModal.jsx";
import { useLiveGeolocation } from '../../utils/useLiveGeolocation.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import { MasterPageHeader, MasterStats, MasterToolbar, MasterSearch, MasterResults, MasterSelect } from '../../components/MasterDataPage.jsx';

const FLOOR_LEVELS = [
  'Basement',
  '1st Floor', '2nd Floor', '3rd Floor', '4th Floor',
  '5th Floor', '6th Floor', '7th Floor', '8th Floor',
  '9th Floor', '10th Floor', '11th Floor', '12th Floor',
  '13th Floor', '14th Floor', '15th Floor'
];
const MAX_FLOOR_LEVEL = 15;

function numericFloorLevel(floorName) {
  const match = String(floorName || '').match(/(?:^|[-\s])(\d+)\s*(?:st|nd|rd|th)?\s*floor\b/i);
  return match ? Number(match[1]) : null;
}

function isBasementFloor(floorName) {
  return /(?:^|[-\s])basement\s*$/i.test(String(floorName || ''));
}

function floorLevelLabel(level) {
  const number = Number(level);
  const mod100 = number % 100;
  const suffix = mod100 >= 11 && mod100 <= 13
    ? 'th'
    : ({ 1: 'st', 2: 'nd', 3: 'rd' }[number % 10] || 'th');
  return `${number}${suffix} Floor`;
}

function FloorIndex(){
  const { user } = React.useContext(AuthContext) || {};
  const canManage = Number(user?.role_id) === 1;
  const [floors, setFloors] = React.useState([]);
  const [allFloors, setAllFloors] = React.useState([]);
  const [buildings, setBuildings] = React.useState([]);
  const [showModal, setShowModal] = React.useState(false);
  const [qrModalOpen, setQrModalOpen] = React.useState(false);
  const [qrModalToken, setQrModalToken] = React.useState(null);
  const [qrModalManualCode, setQrModalManualCode] = React.useState(null);
  const [qrModalFloorId, setQrModalFloorId] = React.useState(null);
  const [qrModalStatus, setQrModalStatus] = React.useState('inactive');
  const [qrModalFloorName, setQrModalFloorName] = React.useState('');
  const [qrModalBuildingName, setQrModalBuildingName] = React.useState('');
  const [regeneratingManualCode, setRegeneratingManualCode] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [form, setForm] = React.useState({ building_id:'', floor_name:'', baseline_altitude:'', floor_meter_vertical:'' });
  const [selectedFloorLevel, setSelectedFloorLevel] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [lastAltitude, setLastAltitude] = React.useState(null);
  const [selectedBuildingId, setSelectedBuildingId] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('active');

  const runWithFallback = async (primary, fallback) => {
    try { return await primary(); } catch (err) {
      if (err?.status === 405 || err?.status === 500) return await fallback();
      throw err;
    }
  };

  const loadData = React.useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
      setError('');
    }
    try{
      const [f, b] = await Promise.all([apiGet('floors'), apiGet('buildings')]);
      setFloors(Array.isArray(f) ? f : []);
      setAllFloors(Array.isArray(f) ? f : []);
      setBuildings(Array.isArray(b) ? b : []);
    }catch(e){ console.error(e); if (!silent) setError('Failed to load floors or buildings'); }
    finally { if (!silent) setLoading(false); }
  }, []);

  const activeBuildings = React.useMemo(() => {
    return buildings.filter(b => String(b.status || '').toLowerCase() === 'active' && (!b.school_id || String(b.school_status || '').toLowerCase() === 'active'));
  }, [buildings]);

  React.useEffect(() => {
    if (selectedBuildingId && !activeBuildings.some((building) => String(building.building_id) === String(selectedBuildingId))) {
      setSelectedBuildingId('');
    }
  }, [activeBuildings, selectedBuildingId]);

  const nextFloorLevel = React.useMemo(() => {
    if (editing || !form.building_id) return null;
    const highest = allFloors
      .filter((floor) => String(floor.building_id) === String(form.building_id))
      .reduce((max, floor) => {
        const level = numericFloorLevel(floor.floor_name);
        return level === null ? max : Math.max(max, level);
      }, 0);
    return highest + 1;
  }, [allFloors, editing, form.building_id]);

  const basementExists = React.useMemo(() => {
    if (!form.building_id) return false;
    return allFloors.some((floor) => (
      String(floor.building_id) === String(form.building_id)
      && isBasementFloor(floor.floor_name)
    ));
  }, [allFloors, form.building_id]);

  const floorLimitReached = !editing && nextFloorLevel !== null && nextFloorLevel > MAX_FLOOR_LEVEL;

  React.useEffect(() => {
    if (editing || !form.building_id || nextFloorLevel === null) return;
    const level = floorLimitReached ? (basementExists ? '' : 'Basement') : floorLevelLabel(nextFloorLevel);
    const building = activeBuildings.find((item) => String(item.building_id) === String(form.building_id));
    setSelectedFloorLevel(level);
    setForm((previous) => ({
      ...previous,
      floor_name: level && building?.building_name ? `${building.building_name}-${level}` : level,
    }));
  }, [editing, form.building_id, nextFloorLevel, floorLimitReached, basementExists, activeBuildings]);

  React.useEffect(() => {
    loadData();
  }, [loadData]);

  const filteredFloors = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    return floors.filter((floor) => (!selectedBuildingId || String(floor.building_id) === String(selectedBuildingId)) && (!query || `${floor.floor_name || ''} ${floor.building_name || ''}`.toLowerCase().includes(query)) && String(floor.status || '').toLowerCase() === statusFilter);
  }, [floors, selectedBuildingId, search, statusFilter]);

  useAutoRefresh({
    refresh: () => loadData({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.ADMIN,
    enabled: !showModal && !qrModalOpen,
  });

  const parseFloorLevel = (floorName) => {
    if (!floorName) return '';
    const parts = String(floorName).split('-');
    const level = parts.length > 1 ? parts.slice(1).join('-') : parts[0];
    return FLOOR_LEVELS.find(l => l.toLowerCase() === level.trim().toLowerCase()) || level.trim();
  };

  const openModal = (fl=null) => {
    setError('');
    if (fl) {
      setEditing(fl);
      setForm({ building_id: fl.building_id || '', floor_name: fl.floor_name || '', baseline_altitude: fl.baseline_altitude ?? '', floor_meter_vertical: fl.floor_meter_vertical ?? '' });
      setSelectedFloorLevel(parseFloorLevel(fl.floor_name));
    } else {
      setEditing(null);
      setForm({ building_id: activeBuildings[0]?.building_id || '', floor_name:'', baseline_altitude:'', floor_meter_vertical:'' });
      setSelectedFloorLevel('');
    }
    setShowModal(true);
  };
  const closeModal = ()=> {
    stopLiveAltitude();
    setLastAltitude(0);
    setShowModal(false);
  };
  const handleChange = (e)=> setForm(p=>({...p, [e.target.name]: e.target.value}));

  const handleFloorLevelChange = (e) => {
    const level = e.target.value;
    setSelectedFloorLevel(level);
    const building = activeBuildings.find(b => String(b.building_id) === String(form.building_id));
    const buildingName = building?.building_name || '';
    if (level && buildingName) {
      setForm(p => ({ ...p, floor_name: `${buildingName}-${level}` }));
    } else {
      setForm(p => ({ ...p, floor_name: level }));
    }
  };

  const handleBuildingChange = (e) => {
    const bId = e.target.value;
    setSelectedFloorLevel('');
    setForm(p => ({ ...p, building_id: bId, floor_name: '' }));
  };

  const updateLiveAltitude = (coords = {}) => {
    const alt = (typeof coords.altitude === 'number' && !isNaN(coords.altitude)) ? Number(coords.altitude) : null;
    setLastAltitude(alt);
  };

  const {
    active: liveAltActive,
    start: startLiveAltitude,
    stop: stopLiveAltitude
  } = useLiveGeolocation({
    onPosition: updateLiveAltitude,
    onError: (message, err) => {
      if (err) console.error('geolocation error', err);
      setError(message || 'Failed to watch position');
    }
  });

  const captureAltitude = () => {
    setError('');
    if (liveAltActive) {
      stopLiveAltitude();
      setLastAltitude(0);
      return;
    }
    setShowModal(true);
    setLastAltitude(null);
    startLiveAltitude();
  };

  const applyLiveAltitude = () => {
    setError('');
    if (!liveAltActive) {
      setError('Start Live first.');
      return;
    }
    if (lastAltitude == null) {
      setError('No live altitude available. Start Live first.');
      return;
    }
    setForm(prev => ({ ...prev, baseline_altitude: Number(lastAltitude).toFixed(1) }));
  };

  const validateForm = () => {
    const name = (form.floor_name||'').trim();
    if (!name) return 'Floor name is required';
    if (!form.building_id) return 'Building is required';
    const bId = Number(form.building_id);
    const conflictName = floors.find(f => f.floor_name && String(f.floor_name).toLowerCase() === name.toLowerCase() && Number(f.building_id) === bId && (!editing || Number(f.floor_id) !== Number(editing.floor_id)));
    if (conflictName) return 'A floor with the same name already exists in this building';
    const alt = form.baseline_altitude !== '' && form.baseline_altitude !== null ? Number(form.baseline_altitude) : null;
    if (alt !== null) {
      const conflictAlt = floors.find(f => f.baseline_altitude !== null && Math.abs(Number(f.baseline_altitude) - alt) < 0.0000001 && Number(f.building_id) === bId && (!editing || Number(f.floor_id) !== Number(editing.floor_id)));
      if (conflictAlt) return 'Another floor with same baseline altitude exists in this building';
    }
    return null;
  };

  const handleSubmit = async (e)=>{
    e.preventDefault(); setLoading(true); setError('');
    const v = validateForm();
    if (v) { try { if (window.Swal) await window.Swal.fire({ icon:'warning', title:'Validation', text: v }); else alert(v); } catch(e){} setLoading(false); return; }
    try{
      const payload = { building_id: Number(form.building_id), floor_name: form.floor_name.trim(), baseline_altitude: form.baseline_altitude !== '' ? Number(form.baseline_altitude) : null, floor_meter_vertical: form.floor_meter_vertical !== '' ? Number(form.floor_meter_vertical) : null };
      if (editing && editing.floor_id) {
        await runWithFallback(
          () => apiPut(`floors/${editing.floor_id}`, payload),
          () => apiPost(`floors/${editing.floor_id}/update`, payload)
        );
      } else {
        await apiPost('floors', payload);
      }
      const f = await apiGet('floors');
      setAllFloors(Array.isArray(f) ? f : []);
      setFloors(Array.isArray(f) ? f : []);
      closeModal();
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: editing ? 'Floor updated' : 'Floor added', timer:1400, showConfirmButton:false }); } catch(e){}
    } catch (err) {
      console.error(err);
      const msg = err?.body?.message || err?.body?.error || err?.message || 'Failed to save';
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: msg }); else alert(msg); } catch(e){}
      setError(msg);
    } finally { setLoading(false); }
  };

  const handleToggle = async (fl)=>{
    if (!fl || !fl.floor_id) return;
    const newStatus = String(fl.status) === 'active' ? 'inactive' : 'active';
    const action = newStatus === 'active' ? 'Activate' : 'Deactivate';
    const answer = window.Swal ? await window.Swal.fire({ title: `${action} floor?`, text: `${fl.floor_name || 'This floor'} and its attendance access will be ${newStatus}.`, icon: 'question', showCancelButton: true, confirmButtonText: action }) : { isConfirmed: confirm(`${action} this floor?`) };
    if (!answer.isConfirmed) return;
    try{
      await runWithFallback(
        () => apiPut(`floors/${fl.floor_id}`, { status: newStatus }),
        () => apiPost(`floors/${fl.floor_id}/update`, { status: newStatus })
      );
      try {
        await apiPost(`floors/${fl.floor_id}/qr/toggle-active`, { active: newStatus === 'active' ? 1 : 0 });
      } catch(qe) { console.warn('QR toggle failed', qe); }
      const f = await apiGet('floors');
      setFloors(Array.isArray(f) ? f : []);
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Status updated', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) {
      console.error(err);
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.error || err.message || 'Failed to update status' }); else alert(err.body?.error || err.message || 'Failed to update status'); } catch(e){}
    }
  };

  const handleArchive = async (fl)=>{
    if (!fl || !fl.floor_id) return;
    try{
      const res = window.Swal ? await window.Swal.fire({ title: 'Archive floor?', text: 'This will remove the floor from the active list.', icon: 'warning', showCancelButton: true }) : { isConfirmed: confirm('Archive floor?') };
      if (!res.isConfirmed) return;
      await runWithFallback(
        () => apiPut(`floors/${fl.floor_id}`, { status: 'archive' }),
        () => apiPost(`floors/${fl.floor_id}/update`, { status: 'archive' })
      );
      // Archive status itself disables QR/manual attendance. Do not call the
      // QR toggle endpoint after archiving because archived records are locked.
      const f = await apiGet('floors');
      setFloors(Array.isArray(f) ? f : []);
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Archived', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) {
      console.error(err);
      const message = err.body?.message || err.body?.error || err.message || 'Failed to archive';
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Cannot archive floor', text: message }); else alert(message); } catch(e){}
    }
  };

  const handleRestore = async (fl) => {
    if (!fl?.floor_id) return;
    const result = window.Swal ? await window.Swal.fire({ title:'Restore floor?', text:'The floor will be restored as inactive for review.', icon:'question', showCancelButton:true }) : { isConfirmed:confirm('Restore floor?') };
    if (!result.isConfirmed) return;
    try {
      await runWithFallback(() => apiPut(`floors/${fl.floor_id}`, { status:'inactive' }), () => apiPost(`floors/${fl.floor_id}/update`, { status:'inactive' }));
      await loadData();
      if (window.Swal) await window.Swal.fire({ icon:'success', title:'Floor restored', timer:1200, showConfirmButton:false });
    } catch (err) {
      if (window.Swal) await window.Swal.fire({ icon:'error', title:'Restore failed', text:err?.body?.message || err?.message || 'Failed to restore floor' });
    }
  };

  const handleViewQr = (r)=>{
    if (!r) return;
    setQrModalToken(r.qr_token);
    setQrModalManualCode(r.manual_code || null);
    setQrModalFloorId(r.floor_id || null);
    setQrModalStatus(r.status || 'inactive');
    setQrModalFloorName(r.floor_name || 'Floor');
    setQrModalBuildingName(r.building_name || '');
    setQrModalOpen(true);
  };

  const handleRegenerateQr = async (floorId)=>{
    const confirmation = window.Swal ? await window.Swal.fire({ title:'Regenerate Floor QR?', text:'The previous QR and manual code for this floor will stop working.', icon:'warning', showCancelButton:true, confirmButtonText:'Regenerate QR', confirmButtonColor:'#dc2626' }) : { isConfirmed:confirm('Regenerate this floor QR? The previous code will stop working.') };
    if (!confirmation.isConfirmed) return;
    try{
      const data = await apiPost(`floors/${floorId}/qr/regenerate`, {});
      setQrModalToken(data.qr_token);
      setQrModalManualCode(data.manual_code || null);
      setQrModalFloorId(floorId);
      setQrModalStatus(data.status || 'active');
      setQrModalOpen(true);
      await loadData();
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'QR regenerated', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) { console.error(err); setError(err.body?.error || err.message || 'Failed to regenerate QR'); }
  };

  const handleRegenerateManualCode = async ()=>{
    if (!qrModalFloorId || regeneratingManualCode) return;
    const result = window.Swal
      ? await window.Swal.fire({ title:'Regenerate manual code?', text:'The QR image will not change, but the previous manual code will stop working.', icon:'warning', showCancelButton:true, confirmButtonText:'Regenerate' })
      : { isConfirmed: confirm('Regenerate the manual code? The QR image will not change.') };
    if (!result.isConfirmed) return;
    setRegeneratingManualCode(true);
    try {
      const data = await apiPost(`floors/${qrModalFloorId}/manual-code/regenerate`, {});
      setQrModalManualCode(data.manual_code || null);
      await loadData();
      if (window.Swal) await window.Swal.fire({ icon:'success', title:'Manual code regenerated', timer:1400, showConfirmButton:false });
    } catch (err) {
      console.error(err);
      const message = err?.body?.message || err?.body?.error || err?.message || 'Failed to regenerate manual code';
      if (window.Swal) await window.Swal.fire({ icon:'error', title:'Regeneration failed', text:message });
      else setError(message);
    } finally {
      setRegeneratingManualCode(false);
    }
  };

  const columns = [
    { key:'rownum', label:'#', render: (r,pIdx,gIdx)=> gIdx + 1 },
    { key:'floor_name', label:'Floor' },
    { key:'building_name', label:'Building' },
    { key:'baseline_altitude', label:'Baseline Alt (m)' },
    { key:'floor_meter_vertical', label:'Floor Vertical (m)' },
    { key:'status', label:'Status', render: (r)=>{
      const s = (r.status||'').toLowerCase();
      const cls = s === 'active' ? 'bg-success' : (s === 'inactive' ? 'bg-danger' : 'bg-secondary');
      const text = s === 'active' ? 'Active' : (s === 'inactive' ? 'Inactive' : (r.status || 'N/A'));
      return (<span className={`mdp-status mdp-status-${s}`}>{text}</span>);
    }},
    { key:'actions', label:'Actions', actions: (row) => {
      if (!canManage) return [{ label:'View / Download QR', onClick:() => handleViewQr(row) }];
      return String(row.status || '').toLowerCase() === 'archive'
        ? [{ label:'Restore', variant:'success', onClick:() => handleRestore(row) }]
        : [{ label:'View QR', onClick:() => handleViewQr(row) }, { label:'Edit', onClick:() => openModal(row) }, { label:'Toggle', onClick:() => handleToggle(row) }, { label:'Archive', variant:'danger', onClick:() => handleArchive(row) }];
    }}
  ];
  const selectFloorStatus = (status) => {
    if (!canManage && status === 'archive') return;
    setStatusFilter(status);
  };
  const floorStatusCount = (status) => floors.filter((item) => String(item.status || '').toLowerCase() === status).length;
  const floorStats = [
    { label: 'Active', value: floorStatusCount('active'), help: 'QR ready for attendance', icon: '\u2713', active: statusFilter === 'active', onClick: () => selectFloorStatus('active') },
    { label: 'Inactive', value: floorStatusCount('inactive'), help: 'QR available for download', icon: 'I', tone: 'red', active: statusFilter === 'inactive', onClick: () => selectFloorStatus('inactive') },
  ];
  if (canManage) floorStats.push({ label: 'Archived', value: floorStatusCount('archive'), help: 'Available for restoration', icon: 'A', active: statusFilter === 'archive', onClick: () => selectFloorStatus('archive') });

  return (
    <div className="mdp-page">
      <MasterPageHeader title="Floors" description={canManage ? 'Configure building floors, altitude calibration, and QR verification.' : 'View floor QR access codes and download a copy for posting.'} action={canManage ? <button className="mdp-primary" onClick={()=>openModal()}>+ Add Floor</button> : null} />
      <MasterStats loading={loading} items={floorStats} />
      <MasterToolbar><MasterSearch value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search floor or building..." /><MasterSelect label="Building" value={selectedBuildingId} onChange={(event) => setSelectedBuildingId(event.target.value)}><option value="">All active buildings</option>{activeBuildings.map((building) => <option key={building.building_id} value={building.building_id}>{building.building_name || building.building_id}</option>)}</MasterSelect><MasterSelect label="Status" value={statusFilter} onChange={(event) => selectFloorStatus(event.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option>{canManage ? <option value="archive">Archived</option> : null}</MasterSelect></MasterToolbar>

      {error && <div className="mb-3 text-red-600">{error}</div>}
      {lastAltitude != null && (
        <div className="mb-3 text-sm text-gray-700">
          Live altitude: {Number(lastAltitude).toFixed(1)}m
        </div>
      )}

      <MasterResults title="Floor Directory" count={filteredFloors.length} loading={loading} description={canManage ? 'Building hierarchy, altitude baselines, and verification readiness.' : 'Open a floor to preview and download its existing QR code.'}><Table columns={columns} data={filteredFloors} loading={loading} pageSize={10} /></MasterResults>

      {canManage ? <Modal show={showModal} title={editing ? 'Edit Floor' : 'Add Floor'} onClose={closeModal} size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Building</label>
            <select name="building_id" value={form.building_id} onChange={handleBuildingChange} required disabled={Boolean(editing)} className="block w-full border border-gray-200 rounded px-3 py-2 disabled:bg-gray-100">
              <option value="">Select building</option>
              {editing && !activeBuildings.some((building) => String(building.building_id) === String(form.building_id)) ? (
                <option value={form.building_id}>{editing.building_name || form.building_id} (Archived)</option>
              ) : null}
              {activeBuildings.map(b => <option key={b.building_id} value={b.building_id}>{b.building_name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Floor Level</label>
            <select value={selectedFloorLevel} onChange={handleFloorLevelChange} required disabled={Boolean(editing) || !form.building_id} className="block w-full border border-gray-200 rounded px-3 py-2 disabled:bg-gray-100">
              <option value="">{!form.building_id ? 'Select building first' : 'Select floor level'}</option>
              {editing && selectedFloorLevel ? <option value={selectedFloorLevel}>{selectedFloorLevel}</option> : null}
              {!editing && !floorLimitReached && nextFloorLevel ? <option value={floorLevelLabel(nextFloorLevel)}>{floorLevelLabel(nextFloorLevel)} (Next floor)</option> : null}
              {!editing && !basementExists ? <option value="Basement">Basement</option> : null}
            </select>
            <input name="floor_name" value={form.floor_name} onChange={handleChange} type="hidden" />
            {floorLimitReached ? (
              <p className="mt-1 text-sm text-red-600">This building has reached the maximum of {MAX_FLOOR_LEVEL} numbered floors. You may add Basement if it does not exist yet.</p>
            ) : null}
            {basementExists && !editing ? <p className="mt-1 text-xs text-gray-500">This building already has a Basement.</p> : null}
            {form.floor_name && (
              <p className="mt-1 text-xs text-gray-500">Will be saved as: <strong>{form.floor_name}</strong></p>
            )}
          </div>

          {!editing ? (
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900" role="note">
              <div className="font-semibold">Android GPS altitude calibration</div>
              <p className="mt-1">Turn on Location/GPS and allow precise location access before starting the live altitude reading. Floor altitude calibration on this page is intended for Android devices; iOS uses a different altitude reference and is not supported for this calibration.</p>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Baseline Altitude (m)</label>
              <input name="baseline_altitude" type="number" step="0.1" value={form.baseline_altitude} onChange={handleChange} className="block w-full border border-gray-200 rounded px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Floor Vertical Meter (m)</label>
              <input name="floor_meter_vertical" type="number" step="0.01" value={form.floor_meter_vertical} onChange={handleChange} className="block w-full border border-gray-200 rounded px-3 py-2" />
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={captureAltitude} className={`px-3 py-2 rounded border ${liveAltActive ? 'bg-yellow-200' : ''}`}>{liveAltActive ? 'Stop Live' : 'Start Live'}</button>
            <button type="button" onClick={applyLiveAltitude} className="px-3 py-2 rounded border">Apply Live</button>
            <div className="text-sm text-gray-600">Live: {liveAltActive ? 'ON' : 'OFF'} | Altitude: {lastAltitude != null ? `${Number(lastAltitude).toFixed(1)}m` : (form.baseline_altitude || 'N/A')}</div>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeModal} className="px-3 py-2 rounded border">Cancel</button>
            <button type="submit" disabled={loading || (!editing && !selectedFloorLevel)} className="px-4 py-2 rounded bg-green-600 text-white disabled:opacity-50">{loading ? 'Saving...' : (editing ? 'Update Floor' : 'Save Floor')}</button>
          </div>
        </form>
      </Modal> : null}

      <QrModal
        key={qrModalToken || 'qrmodal'}
        show={qrModalOpen}
        onClose={()=>setQrModalOpen(false)}
        token={qrModalToken}
        manualCode={qrModalManualCode}
        active={qrModalStatus === 'active'}
        floorName={qrModalFloorName}
        buildingName={qrModalBuildingName}
        readOnly={!canManage}
        onRegenerateManualCode={canManage ? handleRegenerateManualCode : undefined}
        regeneratingManualCode={regeneratingManualCode}
      />
    </div>
  );
}

export default FloorIndex;

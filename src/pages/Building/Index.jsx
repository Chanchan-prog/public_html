import React from 'react';
import { apiFetch, apiGet, apiPost, apiPut } from '../../services/api.js';
import Table from "../../components/Table.jsx";
import Modal from "../../components/Modal.jsx";
import { useLiveGeolocation } from '../../utils/useLiveGeolocation.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import { MasterPageHeader, MasterStats, MasterToolbar, MasterSearch, MasterResults, MasterSelect } from '../../components/MasterDataPage.jsx';

function BuildingIndex(){
  const [buildings, setBuildings] = React.useState([]);
  const [schools, setSchools] = React.useState([]);
  const [showModal, setShowModal] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [form, setForm] = React.useState({ building_name: '', school_id: '', latitude: '', longitude: '', radius: '' });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [lastCoords, setLastCoords] = React.useState(null);
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('active');
  const [modelFile, setModelFile] = React.useState(null);
  const [modelInputKey, setModelInputKey] = React.useState(0);

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
      const [d, s] = await Promise.all([apiGet('buildings'), apiGet('school')]);
      setBuildings(Array.isArray(d) ? d : []);
      setSchools(Array.isArray(s) ? s.filter(x => String(x.status || '').toLowerCase() === 'active') : []);
    }catch(e){ console.error(e); if (!silent) setError('Failed to load buildings'); }
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

  const openModal = (b=null) => {
    setError('');
    setModelFile(null);
    setModelInputKey((value) => value + 1);
    if (b) {
      setEditing(b);
      setForm({ building_name: b.building_name || '', school_id: b.school_id || '', latitude: b.latitude ?? '', longitude: b.longitude ?? '', radius: b.radius ?? '' });
    } else {
      setEditing(null);
      setForm({ building_name:'', school_id: schools[0]?.school_id || '', latitude: '', longitude: '', radius: '' });
    }
    setShowModal(true);
  };
  const closeModal = ()=> {
    stopLiveGps();
    setLastCoords({ latitude: 0, longitude: 0 });
    setShowModal(false);
    setModelFile(null);
    setModelInputKey((value) => value + 1);
  };
  const handleChange = (e) => setForm(p=>({...p,[e.target.name]: e.target.value}));

  const updateLiveCoords = (coords = {}) => {
    const lat = (typeof coords.latitude === 'number') ? Number(coords.latitude) : null;
    const lon = (typeof coords.longitude === 'number') ? Number(coords.longitude) : null;
    setLastCoords({ latitude: lat, longitude: lon });
  };

  const {
    active: liveGpsActive,
    start: startLiveGps,
    stop: stopLiveGps
  } = useLiveGeolocation({
    onPosition: updateLiveCoords,
    onError: (message, err) => {
      if (err) console.error('geolocation error', err);
      setError(message || 'Failed to watch position');
    }
  });

  const captureGps = () => {
    setError('');
    if (liveGpsActive) {
      stopLiveGps();
      setLastCoords({ latitude: 0, longitude: 0 });
      return;
    }
    setShowModal(true);
    setLastCoords(null);
    startLiveGps();
  };

  const applyLiveCoords = () => {
    setError('');
    if (!liveGpsActive) {
      setError('Start Live GPS first.');
      return;
    }
    if (!lastCoords) {
      setError('No live coordinates available. Start Live GPS first.');
      return;
    }
    const { latitude, longitude } = lastCoords;
    if (latitude == null || longitude == null) {
      setError('Live coordinates are not available yet.');
      return;
    }
    setForm(prev => ({
      ...prev,
      latitude: Number(latitude).toFixed(7),
      longitude: Number(longitude).toFixed(7)
    }));
  };

  const validateForm = () => {
    const name = (form.building_name||'').trim();
    if (!name) return 'Building name is required';
    const conflictName = buildings.find(b => b.building_name && String(b.building_name).toLowerCase() === name.toLowerCase() && (!editing || Number(b.building_id) !== Number(editing.building_id)));
    if (conflictName) return 'A building with the same name already exists';
    const lat = form.latitude !== '' && form.latitude !== null ? Number(form.latitude) : null;
    const lon = form.longitude !== '' && form.longitude !== null ? Number(form.longitude) : null;
    if (lat !== null && lon !== null) {
      const conflictLL = buildings.find(b => b.latitude !== null && b.longitude !== null && Math.abs(Number(b.latitude) - lat) < 0.0000001 && Math.abs(Number(b.longitude) - lon) < 0.0000001 && (!editing || Number(b.building_id) !== Number(editing.building_id)));
      if (conflictLL) return 'Another building with same latitude/longitude exists';
    }
    return null;
  };

  const handleModelFileChange = (event) => {
    const file = event.target.files?.[0] || null;
    if (!file) {
      setModelFile(null);
      return;
    }
    if (!String(file.name || '').toLowerCase().endsWith('.glb')) {
      setError('Only binary .glb building models are allowed.');
      event.target.value = '';
      setModelFile(null);
      return;
    }
    if (file.size <= 0 || file.size > 40 * 1024 * 1024) {
      setError('The GLB must be larger than 0 bytes and no more than 40 MB.');
      event.target.value = '';
      setModelFile(null);
      return;
    }
    setError('');
    setModelFile(file);
  };

  const uploadBuildingModel = async (buildingId, file) => {
    const payload = new FormData();
    payload.append('model', file, file.name);
    return apiFetch(`buildings/${buildingId}/model`, { method: 'POST', body: payload });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError('');
    const v = validateForm();
    if (v) { try { if (window.Swal) await window.Swal.fire({ icon:'warning', title:'Validation', text: v }); else alert(v); } catch(e){} setLoading(false); return; }

    if (editing?.model_path && modelFile) {
      const confirmation = window.Swal ? await window.Swal.fire({ title:'Replace Building Model?', text:`${modelFile.name} will replace the current model for ${editing.building_name || 'this building'} after the upload succeeds.`, icon:'warning', showCancelButton:true, confirmButtonText:'Replace Model', confirmButtonColor:'#dc2626' }) : { isConfirmed:confirm('Replace the current building model?') };
      if (!confirmation.isConfirmed) { setLoading(false); return; }
    }

    try{
      const payload = {
        building_name: form.building_name.trim(),
        school_id: form.school_id ? Number(form.school_id) : null,
        latitude: form.latitude !== '' ? Number(form.latitude) : null,
        longitude: form.longitude !== '' ? Number(form.longitude) : null,
        radius: form.radius !== '' ? Number(form.radius) : 0
      };
      let savedBuildingId = editing?.building_id || null;
      if (editing && editing.building_id) {
        await runWithFallback(
          () => apiPut(`buildings/${editing.building_id}`, payload),
          () => apiPost(`buildings/${editing.building_id}/update`, payload)
        );
      } else {
        const created = await apiPost('buildings', payload);
        savedBuildingId = created?.building_id || null;
      }

      if (modelFile) {
        if (!savedBuildingId) throw new Error('The building was saved, but its ID was not returned for the GLB upload.');
        try {
          await uploadBuildingModel(savedBuildingId, modelFile);
        } catch (modelError) {
          const refreshed = await apiGet('buildings').catch(() => buildings);
          const refreshedBuildings = Array.isArray(refreshed) ? refreshed : buildings;
          setBuildings(refreshedBuildings);
          const savedBuilding = refreshedBuildings.find((building) => String(building.building_id) === String(savedBuildingId));
          if (savedBuilding) setEditing(savedBuilding);
          const modelMessage = modelError?.body?.message || modelError?.message || 'Unable to upload the GLB.';
          const partialMessage = `The building details were saved, but the GLB upload failed: ${modelMessage}`;
          setError(partialMessage);
          if (window.Swal) await window.Swal.fire({ icon: 'warning', title: 'Building Saved Without GLB', text: partialMessage });
          else alert(partialMessage);
          return;
        }
      }

      const d = await apiGet('buildings');
      setBuildings(Array.isArray(d) ? d : []);
      closeModal();
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: editing ? 'Building updated' : 'Building added', timer: 1400, showConfirmButton: false }); } catch(e){}
    } catch (err) {
      console.error(err);
      const msg = err?.body?.message || err?.body?.error || err?.message || 'Failed to save';
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title: 'Error', text: msg }); else alert(msg); } catch(e){}
      setError(msg);
    } finally { setLoading(false); }
  };

  const handleToggle = async (b) => {
    if (!b || !b.building_id) return;
    const newStatus = String(b.status) === 'active' ? 'inactive' : 'active';
    const action = newStatus === 'active' ? 'Activate' : 'Deactivate';
    const answer = window.Swal ? await window.Swal.fire({ title: `${action} building?`, text: `${b.building_name || 'This building'} will be ${newStatus}.`, icon: 'question', showCancelButton: true, confirmButtonText: action }) : { isConfirmed: confirm(`${action} this building?`) };
    if (!answer.isConfirmed) return;
    try{
      await runWithFallback(
        () => apiPut(`buildings/${b.building_id}`, { status: newStatus }),
        () => apiPost(`buildings/${b.building_id}/update`, { status: newStatus })
      );
      const d = await apiGet('buildings');
      setBuildings(Array.isArray(d) ? d : []);
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Status updated', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) {
      console.error(err);
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.error || err.message || 'Failed to update status' }); else alert(err.body?.error || err.message || 'Failed to update status'); } catch(e){}
    }
  };

  const handleArchive = async (b) => {
    if (!b || !b.building_id) return;
    try{
      const res = window.Swal ? await window.Swal.fire({ title: 'Archive building?', text: 'This will remove the building from the active list.', icon: 'warning', showCancelButton: true }) : { isConfirmed: confirm('Archive building?') };
      if (!res.isConfirmed) return;
      await runWithFallback(
        () => apiPut(`buildings/${b.building_id}`, { status: 'archive' }),
        () => apiPost(`buildings/${b.building_id}/update`, { status: 'archive' })
      );
      const d = await apiGet('buildings');
      setBuildings(Array.isArray(d) ? d : []);
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Archived', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) {
      console.error(err);
      const message = err.body?.message || err.body?.error || err.message || 'Failed to archive';
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Cannot archive building', text: message }); else alert(message); } catch(e){}
    }
  };

  const handleUnarchive = async (b) => {
    if (!b || !b.building_id) return;
    try{
      const res = window.Swal ? await window.Swal.fire({ title: 'Restore building?', text: 'The building will be restored as inactive for review.', icon: 'question', showCancelButton: true }) : { isConfirmed: confirm('Restore building as inactive?') };
      if (!res.isConfirmed) return;
      await runWithFallback(
        () => apiPut(`buildings/${b.building_id}`, { status: 'inactive' }),
        () => apiPost(`buildings/${b.building_id}/update`, { status: 'inactive' })
      );
      const d = await apiGet('buildings');
      setBuildings(Array.isArray(d) ? d : []);
      try { if (window.Swal) await window.Swal.fire({ icon:'success', title: 'Building restored as inactive', timer:1200, showConfirmButton:false }); } catch(e){}
    } catch (err) {
      console.error(err);
      try { if (window.Swal) await window.Swal.fire({ icon:'error', title:'Error', text: err.body?.error || err.message || 'Failed to unarchive' }); else alert(err.body?.error || err.message || 'Failed to unarchive'); } catch(e){}
    }
  };

  const columns = [
    { key: 'rownum', label: '#', render: (r, pIdx, gIdx) => gIdx + 1 },
    { key: 'building_name', label: 'Building Name' },
    { key: 'school_name', label: 'School' },
    { key: 'latitude', label: 'Latitude' },
    { key: 'longitude', label: 'Longitude' },
    { key: 'radius', label: 'Radius (m)' },
    { key: 'model_filename', label: '3D Model', render: (r) => r.model_path
      ? <span className="text-green-700 font-medium">{r.model_filename || 'GLB available'}</span>
      : <span className="text-gray-500">No GLB</span> },
    { key: 'status', label: 'Status', render: (r) => {
      const s = (r.status || '').toLowerCase();
      const cls = s === 'active' ? 'bg-success' : (s === 'inactive' ? 'bg-danger' : 'bg-secondary');
      const text = s === 'active' ? 'Active' : (s === 'inactive' ? 'Inactive' : 'Archived');
      return (<span className={`mdp-status mdp-status-${s}`}>{text}</span>);
    }},
    { key: 'actions', label: 'Actions', actions: (row) => String(row.status || '').toLowerCase() === 'archive'
      ? [{ label: 'Unarchive', variant: 'success', onClick: () => handleUnarchive(row) }]
      : [
          { label: 'Edit', onClick: () => openModal(row) },
          { label: 'Toggle', onClick: () => handleToggle(row) },
          { label: 'Archive', variant: 'danger', onClick: () => handleArchive(row) }
        ] }
  ];

  const filteredBuildings = buildings.filter((building) => {
    const query = search.trim().toLowerCase();
    const buildingStatus = String(building.status || '').toLowerCase();
    const matchesStatus = buildingStatus === statusFilter;
    return (!query || `${building.building_name || ''} ${building.school_name || ''}`.toLowerCase().includes(query)) && matchesStatus;
  });
  const buildingStatusCount = (status) => buildings.filter((item) => String(item.status || '').toLowerCase() === status).length;

  return (
    <div className="mdp-page">
      <MasterPageHeader title="Buildings" description="Manage campus buildings and GPS boundaries used for attendance validation." action={<button className="mdp-primary" onClick={()=>openModal()}>+ Add Building</button>} />
      <MasterStats loading={loading} items={[{ label: 'Active', value: buildingStatusCount('active'), help: 'Available for use', icon: '\u2713', active: statusFilter === 'active', onClick: () => setStatusFilter('active') }, { label: 'Inactive', value: buildingStatusCount('inactive'), help: 'Currently unavailable', icon: 'I', tone: 'red', active: statusFilter === 'inactive', onClick: () => setStatusFilter('inactive') }, { label: 'Archived', value: buildingStatusCount('archive'), help: 'Available for restoration', icon: 'A', active: statusFilter === 'archive', onClick: () => setStatusFilter('archive') }]} />
      <MasterToolbar><MasterSearch value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search building or school..." /><MasterSelect label="Status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="archive">Archived</option></MasterSelect></MasterToolbar>

      {error && <div className="mb-3 text-red-600">{error}</div>}
      {lastCoords && (
        <div className="mb-3 text-sm text-gray-700">
          Live coords: Lat: {lastCoords.latitude != null ? Number(lastCoords.latitude).toFixed(7) : 'N/A'}, Lon: {lastCoords.longitude != null ? Number(lastCoords.longitude).toFixed(7) : 'N/A'}
        </div>
      )}

      <MasterResults title="Building Directory" count={filteredBuildings.length} loading={loading} description="School placement and configured attendance boundaries."><Table columns={columns} data={filteredBuildings} loading={loading} pageSize={10} /></MasterResults>

      <Modal show={showModal} title={editing ? 'Edit Building' : 'Add Building'} onClose={closeModal} size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Building Name</label>
            <input name="building_name" value={form.building_name} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2" />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">School</label>
            <select name="school_id" value={form.school_id} onChange={handleChange} className="block w-full border border-gray-200 rounded px-3 py-2">
              <option value="">Select school (optional)</option>
              {schools.map(s => <option key={s.school_id} value={s.school_id}>{s.school_name}</option>)}
            </select>
          </div>

          <div className="rounded border border-gray-200 bg-gray-50 p-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-gray-700">3D Building Model</div>
                <div className="text-xs text-gray-500">Optional GLB file, maximum 40 MB.</div>
              </div>
              <label className="cursor-pointer rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700">
                {editing?.model_path ? 'Change GLB Building' : 'Add GLB Building'}
                <input
                  key={modelInputKey}
                  type="file"
                  accept=".glb,model/gltf-binary"
                  className="hidden"
                  onChange={handleModelFileChange}
                />
              </label>
            </div>
            <div className="text-sm text-gray-700">
              {modelFile
                ? `Selected: ${modelFile.name}`
                : editing?.model_path
                  ? `Current: ${editing.model_filename || editing.model_path}`
                  : 'No GLB selected.'}
            </div>
          </div>

          {/* location_description removed: backend handles optional description columns automatically */}

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Latitude</label>
              <input name="latitude" type="number" step="any" placeholder="e.g. 8.469967" value={form.latitude} onChange={handleChange} className="block w-full border border-gray-200 rounded px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Longitude</label>
              <input name="longitude" type="number" step="any" placeholder="e.g. 124.634364" value={form.longitude} onChange={handleChange} className="block w-full border border-gray-200 rounded px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Radius (m)</label>
              <input name="radius" type="number" step="1" min="0" value={form.radius} onChange={handleChange} className="block w-full border border-gray-200 rounded px-3 py-2" />
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={captureGps} className={`px-3 py-2 rounded border ${liveGpsActive ? 'bg-yellow-200' : ''}`}>{liveGpsActive ? 'Stop Live' : 'Start Live'}</button>
            <button type="button" onClick={applyLiveCoords} className="px-3 py-2 rounded border">Apply Live</button>
            <div className="text-sm text-gray-600">Live: {liveGpsActive ? 'ON' : 'OFF'} | Lat: {lastCoords && lastCoords.latitude != null ? Number(lastCoords.latitude).toFixed(7) : (form.latitude || 'N/A')} | Lon: {lastCoords && lastCoords.longitude != null ? Number(lastCoords.longitude).toFixed(7) : (form.longitude || 'N/A')}</div>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeModal} className="px-3 py-2 rounded border">Cancel</button>
            <button type="submit" disabled={loading} className="px-4 py-2 rounded bg-green-600 text-white">{loading ? 'Saving...' : (editing ? 'Update Building' : 'Save Building')}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default BuildingIndex;


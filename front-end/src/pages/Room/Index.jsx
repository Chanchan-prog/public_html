import React from 'react';
import { apiGet, apiPost, apiPut } from '../../services/api.js'; // Ensure this matches your project structure
import Table from "../../components/Table.jsx";
import Modal from "../../components/Modal.jsx";
import { useLiveGeolocation } from '../../utils/useLiveGeolocation.js';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';
import { MasterPageHeader, MasterStats, MasterToolbar, MasterSearch, MasterResults, MasterSelect } from '../../components/MasterDataPage.jsx';

function numericFloorLevel(floorName) {
  const match = String(floorName || '').match(/(?:^|[-\s])(\d+)\s*(?:st|nd|rd|th)?\s*floor\b/i);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

function normalizedFloorLabel(floor) {
  const level = numericFloorLevel(floor?.floor_name);
  if (level === Number.MAX_SAFE_INTEGER) return String(floor?.floor_name || floor?.floor_id || 'Floor');
  const mod100 = level % 100;
  const suffix = mod100 >= 11 && mod100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[level % 10] || 'th');
  return `${level}${suffix} Floor`;
}

function floorLevelKey(floorName) {
  const level = numericFloorLevel(floorName);
  if (level !== Number.MAX_SAFE_INTEGER) return `level:${level}`;
  const fallback = String(floorName || '').trim().toLowerCase();
  return fallback ? `name:${fallback}` : '';
}

function cleanFloorOptions(floors, buildingId = '') {
  const seen = new Set();
  return (Array.isArray(floors) ? floors : [])
    .filter((floor) => String(floor?.status || '').toLowerCase() === 'active')
    .filter((floor) => !buildingId || String(floor?.building_id) === String(buildingId))
    .filter((floor) => {
      const id = String(floor?.floor_id ?? '');
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => numericFloorLevel(a?.floor_name) - numericFloorLevel(b?.floor_name)
      || String(a?.floor_name || '').localeCompare(String(b?.floor_name || '')));
}

function uniqueFloorLevelOptions(floors, buildingId = '', activeBuildingIds = new Set()) {
  const optionsByLevel = new Map();
  cleanFloorOptions(floors, buildingId)
    .filter((floor) => activeBuildingIds.has(String(floor?.building_id)))
    .forEach((floor) => {
      const key = floorLevelKey(floor?.floor_name);
      if (!key || optionsByLevel.has(key)) return;
      optionsByLevel.set(key, {
        key,
        label: normalizedFloorLabel(floor),
        level: numericFloorLevel(floor?.floor_name),
      });
    });

  return Array.from(optionsByLevel.values()).sort((a, b) =>
    a.level - b.level || a.label.localeCompare(b.label)
  );
}

function RoomIndex(){
  const [rooms, setRooms] = React.useState([]);
  const [roomIdentities, setRoomIdentities] = React.useState([]);
  const [roomPage, setRoomPage] = React.useState(1);
  const [roomPagination, setRoomPagination] = React.useState({ page: 1, page_size: 10, total: 0, total_pages: 1 });
  const [roomStatusCounts, setRoomStatusCounts] = React.useState({ active: 0, inactive: 0, archive: 0 });
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [showModal, setShowModal] = React.useState(false);
  const [editing, setEditing] = React.useState(null);
  const [form, setForm] = React.useState({ building_id: '', floor_id: '', room_name: '', latitude: '', longitude: '', radius: '5', altitude: '' });
  const [lastCoords, setLastCoords] = React.useState(null);
  const [buildings, setBuildings] = React.useState([]);
  const [allFloors, setAllFloors] = React.useState([]);
  const [selectedBuildingId, setSelectedBuildingId] = React.useState('');
  const [selectedFloorLevel, setSelectedFloorLevel] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [debouncedSearch, setDebouncedSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('active');
  const roomRequestRef = React.useRef(0);

  const loadRoomIdentities = React.useCallback(async () => {
    const data = await apiGet('rooms?identities=1');
    setRoomIdentities(Array.isArray(data) ? data : []);
  }, []);

  const loadReferenceData = React.useCallback(async () => {
    try {
      const [buildingData, floorData, identities] = await Promise.all([
        apiGet('buildings'),
        apiGet('floors'),
        apiGet('rooms?identities=1'),
      ]);
      setBuildings(Array.isArray(buildingData) ? buildingData : []);
      setAllFloors(Array.isArray(floorData) ? floorData : []);
      setRoomIdentities(Array.isArray(identities) ? identities : []);
    } catch (referenceError) {
      console.error(referenceError);
      setError('Failed to load room filter options');
    }
  }, []);

  const fetchRooms = React.useCallback(async (silent = false) => {
    const requestId = ++roomRequestRef.current;
    if (!silent) { setLoading(true); setError(''); }
    try {
      const params = new URLSearchParams({
        paginate: '1',
        page: String(roomPage),
        page_size: '10',
        status: statusFilter,
      });
      if (selectedBuildingId) params.set('building_id', selectedBuildingId);
      if (selectedFloorLevel) {
        const activeBuildingIds = new Set(buildings
          .filter((building) => String(building.status || '').toLowerCase() === 'active' && (!building.school_id || String(building.school_status || '').toLowerCase() === 'active'))
          .map((building) => String(building.building_id)));
        const matchingFloorIds = cleanFloorOptions(allFloors, selectedBuildingId)
          .filter((floor) => activeBuildingIds.has(String(floor.building_id)) && floorLevelKey(floor.floor_name) === selectedFloorLevel)
          .map((floor) => floor.floor_id);
        if (matchingFloorIds.length) params.set('floor_ids', matchingFloorIds.join(','));
      }
      if (debouncedSearch) params.set('search', debouncedSearch);
      const data = await apiGet(`rooms?${params.toString()}`);
      if (requestId !== roomRequestRef.current) return;
      const nextRows = Array.isArray(data?.rows) ? data.rows : [];
      const nextPagination = data?.pagination || { page: 1, page_size: 10, total: nextRows.length, total_pages: 1 };
      setRooms(nextRows);
      setRoomPagination(nextPagination);
      setRoomStatusCounts(data?.status_counts || { active: 0, inactive: 0, archive: 0 });
      if (Number(nextPagination.page || 1) !== Number(roomPage)) setRoomPage(Number(nextPagination.page || 1));
    } catch (requestError) {
      if (requestId === roomRequestRef.current && !silent) setError('Failed to load rooms');
    } finally {
      if (requestId === roomRequestRef.current && !silent) setLoading(false);
    }
  }, [roomPage, statusFilter, selectedBuildingId, selectedFloorLevel, debouncedSearch, buildings, allFloors]);

  React.useEffect(() => { loadReferenceData(); }, [loadReferenceData]);
  React.useEffect(() => { fetchRooms(); }, [fetchRooms]);
  React.useEffect(() => {
    const timer = window.setTimeout(() => {
      setRoomPage(1);
      setDebouncedSearch(search.trim());
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useAutoRefresh({
    refresh: () => fetchRooms(true),
    intervalMs: AUTO_REFRESH_INTERVALS.ADMIN,
    enabled: !showModal,
  });

  const activeBuildings = React.useMemo(() => {
    return buildings.filter(b => String(b.status || '').toLowerCase() === 'active' && (!b.school_id || String(b.school_status || '').toLowerCase() === 'active'));
  }, [buildings]);

  React.useEffect(() => {
    if (selectedBuildingId && !activeBuildings.some((building) => String(building.building_id) === String(selectedBuildingId))) {
      setSelectedBuildingId('');
      setSelectedFloorLevel('');
    }
  }, [activeBuildings, selectedBuildingId]);

  const floorFilterOptions = React.useMemo(() => {
    const activeBuildingIds = new Set(activeBuildings.map((building) => String(building.building_id)));
    return uniqueFloorLevelOptions(allFloors, selectedBuildingId, activeBuildingIds);
  }, [allFloors, selectedBuildingId, activeBuildings]);

  const modalFloorOptions = React.useMemo(() => {
    if (!form.building_id) return [];
    return cleanFloorOptions(allFloors, form.building_id);
  }, [allFloors, form.building_id]);

  React.useEffect(() => {
    if (selectedFloorLevel && !floorFilterOptions.some((floor) => floor.key === selectedFloorLevel)) {
      setSelectedFloorLevel('');
    }
  }, [floorFilterOptions, selectedFloorLevel]);

  const handleBuildingFilterChange = (e) => {
    setRoomPage(1);
    setSelectedBuildingId(e.target.value);
    setSelectedFloorLevel('');
  };

  const changeRoomStatus = async (room, status) => {
    try {
      await apiPut(`rooms/${room.room_id}`, { status });
      await Promise.all([fetchRooms(), loadRoomIdentities()]);
      if (window.Swal) await window.Swal.fire({ icon:'success', title:status === 'archive' ? 'Room archived' : status === 'inactive' && String(room.status).toLowerCase() === 'archive' ? 'Room restored' : 'Status updated', timer:1200, showConfirmButton:false });
    } catch (err) {
      const msg = err?.body?.message || err?.body?.error || err?.message || 'Failed to update room status';
      if (window.Swal) await window.Swal.fire({ icon:'error', title:'Status update failed', text:msg });
    }
  };

  const handleToggleStatus = async (room) => {
    const status = String(room.status || '').toLowerCase() === 'active' ? 'inactive' : 'active';
    const action = status === 'active' ? 'Activate' : 'Deactivate';
    const result = window.Swal ? await window.Swal.fire({ title:`${action} room?`, text:`${room.room_name || 'This room'} will be ${status}.`, icon:'question', showCancelButton:true, confirmButtonText:action }) : { isConfirmed:confirm(`${action} this room?`) };
    if (result.isConfirmed) await changeRoomStatus(room, status);
  };
  const handleArchive = async (room) => {
    const result = window.Swal ? await window.Swal.fire({ title:'Archive room?', text:'The room will be removed from operational selectors.', icon:'warning', showCancelButton:true }) : { isConfirmed:confirm('Archive room?') };
    if (result.isConfirmed) await changeRoomStatus(room, 'archive');
  };
  const handleRestore = async (room) => {
    const result = window.Swal ? await window.Swal.fire({ title:'Restore room?', text:'The room will be restored as inactive for review.', icon:'question', showCancelButton:true }) : { isConfirmed:confirm('Restore room?') };
    if (result.isConfirmed) await changeRoomStatus(room, 'inactive');
  };

  const clearFilters = () => {
    setRoomPage(1);
    setSelectedBuildingId('');
    setSelectedFloorLevel('');
  };

  const openModal = (r=null) => {
    setError('');
    if (r) {
      const buildingIsActive = activeBuildings.some((building) => String(building.building_id) === String(r.building_id));
      const floorIsActive = buildingIsActive && cleanFloorOptions(allFloors, r.building_id)
        .some((floor) => String(floor.floor_id) === String(r.floor_id));
      setEditing(r);
      setForm({
        building_id: buildingIsActive ? (r.building_id || '') : '',
        floor_id: floorIsActive ? (r.floor_id || '') : '',
        room_name: r.room_name || '',
        latitude: r.latitude ?? '',
        longitude: r.longitude ?? '',
        radius: r.radius ?? '',
        altitude: r.altitude ?? ''
      });
    } else {
      setEditing(null);
      // reset form and keep any last captured coords visible to the user
      setForm({ building_id: '', floor_id: '', room_name: '', latitude: '', longitude: '', radius: '5', altitude: '' });
    }
    setShowModal(true);
  };
  const closeModal = ()=> {
    stopLiveGps();
    setLastCoords({ latitude: 0, longitude: 0, altitude: 0 });
    setShowModal(false);
  };
  const handleChange = (e) => { const { name, value } = e.target; setForm(prev=> ({ ...prev, [name]: value })); };

  const updateLiveCoords = (coords = {}) => {
    const lat = (typeof coords.latitude === 'number') ? Number(coords.latitude) : null;
    const lon = (typeof coords.longitude === 'number') ? Number(coords.longitude) : null;
    const alt = (typeof coords.altitude === 'number' && !isNaN(coords.altitude)) ? Number(coords.altitude) : null;
    setLastCoords({ latitude: lat, longitude: lon, altitude: alt });
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

  // Start/stop live GPS watch; auto update latitude/longitude continuously
  const captureGps = () => {
    setError('');
    if (liveGpsActive) {
      stopLiveGps();
      setLastCoords({ latitude: 0, longitude: 0, altitude: 0 });
      return;
    }
    // open modal immediately so user can see live updates
    setShowModal(true);
    setLastCoords(null);
    startLiveGps();
  };

  // Apply latest live coordinates into the modal form
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

  // ensure SweetAlert2 is loaded on demand
  const ensureSwalLoaded = async () => {
    if (window.Swal) return window.Swal;
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/sweetalert2@11';
      s.onload = () => resolve(window.Swal);
      s.onerror = () => reject(new Error('Failed to load SweetAlert2'));
      document.head.appendChild(s);
    });
  };

  const handleSubmit = async (ev) => {
    ev.preventDefault();
    setLoading(true); setError('');
    try{
      const payload = {
        building_id: form.building_id ? Number(form.building_id) : null,
        floor_id: form.floor_id ? Number(form.floor_id) : null,
        room_name: (form.room_name || '').trim(),
        latitude: form.latitude !== '' ? parseFloat(form.latitude) : null,
        longitude: form.longitude !== '' ? parseFloat(form.longitude) : null,
        radius: form.radius !== '' ? parseFloat(form.radius) : null,
        altitude: form.altitude !== '' ? (isNaN(Number(form.altitude)) ? null : Number(form.altitude)) : null
      };

      if (payload.room_name && Array.isArray(roomIdentities) && roomIdentities.length) {
        const dupName = roomIdentities.find(r => {
          if (!r.room_name) return false;
          if (editing && editing.room_id && Number(editing.room_id) === Number(r.room_id)) return false;
          const sameName = String(r.room_name).trim().toLowerCase() === String(payload.room_name).trim().toLowerCase();
          const sameBuilding = (payload.building_id == null && (r.building_id == null || r.building_id === '')) || String(r.building_id) === String(payload.building_id);
          const sameFloor = (payload.floor_id == null && (r.floor_id == null || r.floor_id === '')) || String(r.floor_id) === String(payload.floor_id);
          return sameName && sameBuilding && sameFloor;
        });
        if (dupName) {
          try {
            const Swal = await ensureSwalLoaded();
            // show a non-blocking toast warning for 3 seconds
            Swal.fire({
              toast: true,
              position: 'top',
              icon: 'warning',
              title: `Duplicate room name: ${dupName.room_name}`,
              showConfirmButton: false,
              timer: 3000,
              timerProgressBar: true
            });
          } catch (e) {
            console.warn('Duplicate room name detected:', dupName.room_name);
          }
        }
      }

      // duplicate check: same coords already present (ignore current editing row)
      if (payload.latitude != null && payload.longitude != null && Array.isArray(roomIdentities) && roomIdentities.length) {
        const tol = 1e-7; // tolerance for comparing floats
        const dup = roomIdentities.find(r => {
          if (!r.latitude || !r.longitude) return false;
          if (editing && editing.room_id && Number(editing.room_id) === Number(r.room_id)) return false;
          const rlat = Number(r.latitude);
          const rlon = Number(r.longitude);
          return Math.abs(rlat - payload.latitude) <= tol && Math.abs(rlon - payload.longitude) <= tol;
        });
        if (dup) {
          try {
            const Swal = await ensureSwalLoaded();
            // show a non-blocking toast warning for 3 seconds
            Swal.fire({
              toast: true,
              position: 'top',
              icon: 'warning',
              title: `Possible duplicate coordinates (room ${dup.room_name || dup.room_id})`,
              showConfirmButton: false,
              timer: 3000,
              timerProgressBar: true
            });
          } catch (e) {
            console.warn('Duplicate coordinates detected for room:', dup.room_name || dup.room_id);
          }
        }
      }

      if (editing && editing.room_id) {
        // try modern PUT, fallback to POST update if API requires
        try { await apiPut(`rooms/${editing.room_id}`, payload); } catch(e){ await apiPost(`rooms/${editing.room_id}/update`, payload); }
      } else {
        await apiPost('rooms', payload);
      }
      await Promise.all([fetchRooms(), loadRoomIdentities()]);
      // remember last captured coords for display after successful save
      if (payload.latitude != null && payload.longitude != null) {
        setLastCoords({ latitude: payload.latitude, longitude: payload.longitude, altitude: payload.altitude });
      }
      closeModal();
    }catch(e){ console.error(e); setError(e?.message || 'Failed to save room'); }
    finally{ setLoading(false); }
  };

  const columns = [
    { key: 'rownum', label: '#', render: (r, pIdx, gIdx) => gIdx + 1 },
    { key: 'room_name', label: 'Room' },
    { key: 'building_name', label: 'Building' },
    { key: 'floor_name', label: 'Floor' },
    { key: 'latitude', label: 'Latitude' },
    { key: 'longitude', label: 'Longitude' },
    { key: 'radius', label: 'Radius (m)' },
    { 
      key: 'status', 
      label: 'Status', 
      render: (r) => {
        const s = (r.status || '').toLowerCase();
        const cls = s === 'active' ? 'bg-success' : (s === 'inactive' ? 'bg-danger' : 'bg-secondary');
        const text = s === 'active' ? 'Active' : (s === 'inactive' ? 'Inactive' : (r.status || 'N/A'));
        return (<span className={`mdp-status mdp-status-${s}`}>{text}</span>);
      }
    },
    { key:'actions', label:'Actions', actions:(row) => String(row.status || '').toLowerCase() === 'archive'
      ? [{ label:'Restore', variant:'success', onClick:() => handleRestore(row) }]
      : [{ label:'Edit', onClick:() => openModal(row) }, { label:'Toggle', onClick:() => handleToggleStatus(row) }, { label:'Archive', variant:'danger', onClick:() => handleArchive(row) }]
    }
  ];
  const selectRoomStatus = (status) => {
    setRoomPage(1);
    setStatusFilter(status);
  };
  const roomStatusCount = (status) => Number(roomStatusCounts?.[status] || 0);

  return (
    <div className="mdp-page">
      <MasterPageHeader title="Rooms" description="Maintain teaching rooms and their building, floor, and GPS boundaries." action={<button className="mdp-primary" onClick={()=>openModal()}>+ Add Room</button>} />
      <MasterStats loading={loading} items={[{ label: 'Active', value: roomStatusCount('active'), help: 'Available for schedules', icon: '\u2713', active: statusFilter === 'active', onClick: () => selectRoomStatus('active') }, { label: 'Inactive', value: roomStatusCount('inactive'), help: 'Currently unavailable', icon: 'I', tone: 'red', active: statusFilter === 'inactive', onClick: () => selectRoomStatus('inactive') }, { label: 'Archived', value: roomStatusCount('archive'), help: 'Available for restoration', icon: 'A', active: statusFilter === 'archive', onClick: () => selectRoomStatus('archive') }]} />
      <MasterToolbar><MasterSearch value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search room, building, or floor..." /><MasterSelect label="Building" value={selectedBuildingId} onChange={handleBuildingFilterChange}><option value="">All active buildings</option>{activeBuildings.map((building) => <option key={building.building_id} value={building.building_id}>{building.building_name || building.building_id}</option>)}</MasterSelect><MasterSelect label="Floor" value={selectedFloorLevel} onChange={(event) => { setRoomPage(1); setSelectedFloorLevel(event.target.value); }}><option value="">All active floors</option>{floorFilterOptions.map((floor) => <option key={floor.key} value={floor.key}>{floor.label}</option>)}</MasterSelect><MasterSelect label="Status" value={statusFilter} onChange={(event) => selectRoomStatus(event.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="archive">Archived</option></MasterSelect></MasterToolbar>

      {/* Show live/last captured coordinates if available */}
      {lastCoords && (
        <div className="mb-3 text-sm text-gray-700">Live coords: Lat: {lastCoords.latitude != null ? Number(lastCoords.latitude).toFixed(7) : 'N/A'}, Lon: {lastCoords.longitude != null ? Number(lastCoords.longitude).toFixed(7) : 'N/A'}</div>
      )}

      {error && <div className="mb-3 text-red-600">{error}</div>}

      <MasterResults title="Room Directory" count={Number(roomPagination.total || 0)} loading={loading} description="Facility hierarchy and attendance location boundaries."><Table columns={columns} data={rooms} loading={loading} pageSize={Number(roomPagination.page_size || 10)} serverPagination totalItems={Number(roomPagination.total || 0)} page={roomPage} onPageChange={setRoomPage} /></MasterResults>

      <Modal show={showModal} title={editing ? 'Edit Room' : 'Add Room'} onClose={closeModal} size="md">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Room Name</label>
            <input name="room_name" value={form.room_name} onChange={handleChange} required className="block w-full border border-gray-200 rounded px-3 py-2" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Latitude</label>
              <input name="latitude" value={form.latitude} onChange={handleChange} className="block w-full border border-gray-200 rounded px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Longitude</label>
              <input name="longitude" value={form.longitude} onChange={handleChange} className="block w-full border border-gray-200 rounded px-3 py-2" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Radius (m)</label>
              <input name="radius" value={form.radius} onChange={handleChange} className="block w-full border border-gray-200 rounded px-3 py-2" />
            </div>
          </div>

          {/* Building and Floor filters inside modal */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Building</label>
              <select name="building_id" value={form.building_id} onChange={(e)=>{ handleChange(e); /* reset floor when building changes */ setForm(prev=>({ ...prev, floor_id: '' })); }} className="block w-full border border-gray-200 rounded px-3 py-2">
                <option value="">Select building</option>
                {activeBuildings.map(b => (<option key={b.building_id} value={b.building_id}>{b.building_name || b.building_id}</option>))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Floor</label>
              <select
                name="floor_id"
                value={form.floor_id}
                onChange={handleChange}
                disabled={!form.building_id}
                className="block w-full border border-gray-200 rounded px-3 py-2 disabled:bg-gray-100"
              >
                <option value="">{form.building_id ? 'Select floor' : 'Select building first'}</option>
                {form.building_id && modalFloorOptions
                  .map(f => (
                    <option key={f.floor_id} value={f.floor_id}>{normalizedFloorLabel(f)}</option>
                  ))
                }
              </select>
            </div>
          </div>

          {/* Live GPS controls inside modal: start/stop and apply live */}
          <div className="mt-2 flex items-center gap-2">
            <button type="button" onClick={captureGps} className={`px-3 py-2 rounded border ${liveGpsActive ? 'bg-yellow-200' : ''}`}>{liveGpsActive ? 'Stop Live' : 'Start Live'}</button>
            <button type="button" onClick={applyLiveCoords} className="px-3 py-2 rounded border">Apply Live</button>
            <div className="text-sm text-gray-600">Live: {liveGpsActive ? 'ON' : 'OFF'} | Lat: {lastCoords && lastCoords.latitude != null ? Number(lastCoords.latitude).toFixed(7) : (form.latitude || 'N/A')} | Lon: {lastCoords && lastCoords.longitude != null ? Number(lastCoords.longitude).toFixed(7) : (form.longitude || 'N/A')}</div>
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeModal} className="px-3 py-2 rounded border">Cancel</button>
            <button type="submit" disabled={loading} className="px-4 py-2 rounded bg-green-600 text-white">{loading ? 'Saving...' : (editing ? 'Update Room' : 'Save Room')}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

export default RoomIndex;



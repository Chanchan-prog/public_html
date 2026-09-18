import React from 'react';
import { apiUrl, apiGet, apiPost } from '../../services/api.js';
import LoadingState from '../../components/LoadingState.jsx';

export default function DataArchivePage() {
  const [loading, setLoading] = React.useState(true);
  const [records, setRecords] = React.useState([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(0);
  const [search, setSearch] = React.useState('');
  const [dateFrom, setDateFrom] = React.useState('');
  const [dateTo, setDateTo] = React.useState('');
  const [stats, setStats] = React.useState(null);
  const [tab, setTab] = React.useState('list');
  const [selectedIds, setSelectedIds] = React.useState([]);
  const [archiveDate, setArchiveDate] = React.useState('');
  const [archiveReason, setArchiveReason] = React.useState('');
  const [message, setMessage] = React.useState(null);

  React.useEffect(() => {
    loadStats();
    loadRecords();
  }, [page]);

  const loadStats = async () => {
    try {
      const res = await apiGet('archive?action=stats');
      setStats(res);
    } catch (e) {
      console.error('Failed to load archive stats', e);
    }
  };

  const loadRecords = async () => {
    setLoading(true);
    try {
      let url = `archive?action=list&page=${page}&limit=25`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (dateFrom) url += `&date_from=${encodeURIComponent(dateFrom)}`;
      if (dateTo) url += `&date_to=${encodeURIComponent(dateTo)}`;
      const res = await apiGet(url);
      setRecords(res.rows || []);
      setTotal(res.total || 0);
      setTotalPages(res.total_pages || 0);
    } catch (e) {
      console.error('Failed to load archive records', e);
      setRecords([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    loadRecords();
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const toggleSelectAll = () => {
    if (selectedIds.length === records.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(records.map(r => r.archive_id));
    }
  };

  const handleArchive = async () => {
    if (!archiveDate && selectedIds.length === 0) {
      setMessage({ type: 'error', text: 'Please select a date cutoff or specific records.' });
      return;
    }
    setLoading(true);
    setMessage(null);
    try {
      const payload = {
        date_cutoff: archiveDate || undefined,
        reason: archiveReason || 'Manual archive'
      };
      if (selectedIds.length > 0) {
        payload.attendance_ids = selectedIds;
      }
      const res = await apiPost('archive?action=archive', payload);
      setMessage({ type: 'success', text: `Successfully archived ${res.archived_count} records.` });
      setSelectedIds([]);
      loadRecords();
      loadStats();
    } catch (e) {
      setMessage({ type: 'error', text: e.body?.message || e.message || 'Archive failed.' });
    } finally {
      setLoading(false);
    }
  };

  const handleRestore = async () => {
    if (selectedIds.length === 0) {
      setMessage({ type: 'error', text: 'Please select records to restore.' });
      return;
    }
    if (!window.confirm(`Restore ${selectedIds.length} record(s) back to active attendance?`)) return;
    setLoading(true);
    setMessage(null);
    try {
      const res = await apiPost('archive?action=restore', { archive_ids: selectedIds });
      setMessage({ type: 'success', text: `Successfully restored ${res.restored_count} records.` });
      setSelectedIds([]);
      loadRecords();
      loadStats();
    } catch (e) {
      setMessage({ type: 'error', text: e.body?.message || e.message || 'Restore failed.' });
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    try {
      let url = `archive?action=export&format=csv`;
      if (dateFrom) url += `&date_from=${encodeURIComponent(dateFrom)}`;
      if (dateTo) url += `&date_to=${encodeURIComponent(dateTo)}`;
      const response = await fetch(apiUrl(url), {
        credentials: 'include'
      });
      if (!response.ok) throw new Error('Export failed');
      const blob = await response.blob();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'attendance_archive_' + new Date().toISOString().slice(0,10) + '.csv';
      link.click();
      URL.revokeObjectURL(link.href);
      setMessage({ type: 'success', text: 'Archive exported successfully.' });
    } catch (e) {
      setMessage({ type: 'error', text: e.message || 'Export failed.' });
    }
  };

  const containerStyle = { padding: '20px', maxWidth: '1200px', margin: '0 auto' };
  const headerStyle = { fontSize: '1.5rem', fontWeight: 600, marginBottom: '20px', color: '#1a73e8' };
  const tabsStyle = { display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '2px solid #e0e0e0', paddingBottom: '10px' };
  const tabBtnStyle = (active) => ({
    padding: '8px 20px', border: 'none', borderRadius: '6px',
    background: active ? '#1a73e8' : '#f0f0f0',
    color: active ? '#fff' : '#333', cursor: 'pointer', fontWeight: 500
  });
  const tableStyle = { width: '100%', borderCollapse: 'collapse', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' };
  const thStyle = { background: '#f5f5f5', padding: '10px', textAlign: 'left', borderBottom: '2px solid #e0e0e0', fontSize: '0.85rem' };
  const tdStyle = { padding: '8px 10px', borderBottom: '1px solid #eee', fontSize: '0.85rem' };
  const cardStyle = { background: '#fff', padding: '20px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '20px' };

  return (
    <div style={containerStyle}>
      <h2 style={headerStyle}>
        <i className="bi bi-archive" style={{ marginRight: '10px' }}></i>
        Data Archive Management
      </h2>

      {stats && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px', marginBottom: '20px' }}>
          <div style={cardStyle}>
            <div style={{ fontSize: '0.8rem', color: '#666' }}>Total Archived</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#1a73e8' }}>{stats.total_archived}</div>
          </div>
          <div style={cardStyle}>
            <div style={{ fontSize: '0.8rem', color: '#666' }}>Total Exports</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#34a853' }}>{stats.total_exports}</div>
          </div>
          <div style={cardStyle}>
            <div style={{ fontSize: '0.8rem', color: '#666' }}>Archived (30 days)</div>
            <div style={{ fontSize: '1.8rem', fontWeight: 700, color: '#fbbc04' }}>{stats.recent_archived}</div>
          </div>
          <div style={cardStyle}>
            <div style={{ fontSize: '0.8rem', color: '#666' }}>Oldest Archived</div>
            <div style={{ fontSize: '1rem', fontWeight: 600, color: '#ea4335' }}>{stats.oldest_archived_date || 'N/A'}</div>
          </div>
        </div>
      )}

      {message && (
        <div style={{
          padding: '12px 16px', borderRadius: '6px', marginBottom: '15px',
          background: message.type === 'success' ? '#e6f4ea' : '#fce8e6',
          color: message.type === 'success' ? '#137333' : '#c5221f',
          border: `1px solid ${message.type === 'success' ? '#137333' : '#c5221f'}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
        }}>
          <span><i className={`bi bi-${message.type === 'success' ? 'check-circle' : 'exclamation-circle'}`} style={{ marginRight: '8px' }}></i>{message.text}</span>
          <button onClick={() => setMessage(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '1.2rem' }}>&times;</button>
        </div>
      )}

      <div style={tabsStyle}>
        <button style={tabBtnStyle(tab === 'list')} onClick={() => setTab('list')}>
          <i className="bi bi-list-ul" style={{ marginRight: '5px' }}></i>Archive Records
        </button>
        <button style={tabBtnStyle(tab === 'archive')} onClick={() => setTab('archive')}>
          <i className="bi bi-archive-fill" style={{ marginRight: '5px' }}></i>Archive New Records
        </button>
        <button style={tabBtnStyle(tab === 'export')} onClick={() => setTab('export')}>
          <i className="bi bi-download" style={{ marginRight: '5px' }}></i>Export Archive
        </button>
      </div>

      {tab === 'list' && (
        <div>
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: '10px', marginBottom: '15px', flexWrap: 'wrap' }}>
            <input type="text" placeholder="Search by reason or status..." value={search} onChange={e => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: '200px', padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px' }} />
            <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
              style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }} />
            <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
              style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }} />
            <button type="submit" style={{ padding: '8px 16px', background: '#1a73e8', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
              <i className="bi bi-search"></i> Search
            </button>
          </form>

          {selectedIds.length > 0 && (
            <div style={{ marginBottom: '10px', padding: '10px', background: '#e8f0fe', borderRadius: '4px', display: 'flex', gap: '10px', alignItems: 'center' }}>
              <span>{selectedIds.length} record(s) selected</span>
              <button onClick={handleRestore} style={{ padding: '6px 12px', background: '#34a853', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                <i className="bi bi-arrow-counterclockwise"></i> Restore Selected
              </button>
            </div>
          )}

          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, width: '30px' }}><input type="checkbox" checked={selectedIds.length === records.length && records.length > 0} onChange={toggleSelectAll} /></th>
                  <th style={thStyle}>ID</th>
                  <th style={thStyle}>User</th>
                  <th style={thStyle}>Room</th>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}>Time In</th>
                  <th style={thStyle}>Time Out</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Archived At</th>
                  <th style={thStyle}>Archived By</th>
                  <th style={thStyle}>Reason</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={11} style={{ ...tdStyle, padding: 0 }}><LoadingState label="Loading archived records..." compact /></td></tr>
                ) : records.length === 0 ? (
                  <tr><td colSpan={11} style={{ ...tdStyle, textAlign: 'center', padding: '30px', color: '#666' }}>No archived records found.</td></tr>
                ) : records.map(record => (
                  <tr key={record.archive_id} style={{ background: selectedIds.includes(record.archive_id) ? '#f0f7ff' : 'transparent' }}>
                    <td style={tdStyle}><input type="checkbox" checked={selectedIds.includes(record.archive_id)} onChange={() => toggleSelect(record.archive_id)} /></td>
                    <td style={tdStyle}>{record.archive_id}</td>
                    <td style={tdStyle}>{record.user_name}</td>
                    <td style={tdStyle}>{record.room_name}</td>
                    <td style={tdStyle}>{record.date}</td>
                    <td style={tdStyle}>{record.time_in || '-'}</td>
                    <td style={tdStyle}>{record.time_out || '-'}</td>
                    <td style={tdStyle}>
                      <span style={{
                        padding: '2px 8px', borderRadius: '10px', fontSize: '0.75rem',
                        background: record.status === 'present' ? '#e6f4ea' : record.status === 'late' ? '#fef7e0' : '#fce8e6',
                        color: record.status === 'present' ? '#137333' : record.status === 'late' ? '#e37400' : '#c5221f'
                      }}>{record.status || 'N/A'}</span>
                    </td>
                    <td style={tdStyle}>{record.archived_at}</td>
                    <td style={tdStyle}>{record.archived_by_name}</td>
                    <td style={{ ...tdStyle, maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{record.archive_reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', gap: '5px', marginTop: '15px', alignItems: 'center' }}>
              <button disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}
                style={{ padding: '6px 12px', border: '1px solid #ddd', borderRadius: '4px', cursor: page <= 1 ? 'not-allowed' : 'pointer', opacity: page <= 1 ? 0.5 : 1 }}>Previous</button>
              <span style={{ padding: '6px 12px' }}>Page {page} of {totalPages}</span>
              <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}
                style={{ padding: '6px 12px', border: '1px solid #ddd', borderRadius: '4px', cursor: page >= totalPages ? 'not-allowed' : 'pointer', opacity: page >= totalPages ? 0.5 : 1 }}>Next</button>
            </div>
          )}
        </div>
      )}

      {tab === 'archive' && (
        <div style={cardStyle}>
          <h3 style={{ marginBottom: '15px', fontSize: '1.1rem' }}><i className="bi bi-archive-fill" style={{ marginRight: '8px' }}></i>Archive Attendance Records</h3>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>Archive records older than date:</label>
            <input type="date" value={archiveDate} onChange={e => setArchiveDate(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px', width: '100%', maxWidth: '300px' }} />
          </div>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>Reason for archiving:</label>
            <textarea value={archiveReason} onChange={e => setArchiveReason(e.target.value)} placeholder="e.g., End of semester archival"
              style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px', width: '100%', maxWidth: '500px', minHeight: '60px' }} />
          </div>
          <button onClick={handleArchive} disabled={loading}
            style={{ padding: '10px 24px', background: '#ea4335', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 500 }}>
            <i className="bi bi-archive-fill" style={{ marginRight: '5px' }}></i>
            {loading ? 'Archiving...' : 'Archive Records'}
          </button>
        </div>
      )}

      {tab === 'export' && (
        <div style={cardStyle}>
          <h3 style={{ marginBottom: '15px', fontSize: '1.1rem' }}><i className="bi bi-download" style={{ marginRight: '8px' }}></i>Export Archive Data</h3>
          <div style={{ display: 'flex', gap: '15px', marginBottom: '15px', flexWrap: 'wrap' }}>
            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>From:</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
                style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }} />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>To:</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
                style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }} />
            </div>
          </div>
          <button onClick={handleExport} style={{ padding: '10px 24px', background: '#34a853', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 500 }}>
            <i className="bi bi-file-earmark-spreadsheet" style={{ marginRight: '5px' }}></i>Export to CSV
          </button>
        </div>
      )}
    </div>
  );
}

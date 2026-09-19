import React from 'react';
import { apiUrl, apiGet, apiDelete, getCsrfToken } from '../../services/api.js';
import LoadingState from '../../components/LoadingState.jsx';

export default function FileUploadPage() {
  const [loading, setLoading] = React.useState(false);
  const [files, setFiles] = React.useState([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [totalPages, setTotalPages] = React.useState(0);
  const [search, setSearch] = React.useState('');
  const [category, setCategory] = React.useState('');
  const [categories, setCategories] = React.useState([]);
  const [message, setMessage] = React.useState(null);
  const [tab, setTab] = React.useState('list');
  const fileInputRef = React.useRef(null);

  React.useEffect(() => {
    loadCategories();
    loadFiles();
  }, [page, category]);

  const loadCategories = async () => {
    try {
      const res = await apiGet('file-upload?action=categories');
      setCategories(res.categories || []);
    } catch (e) {
      console.error('Failed to load categories', e);
    }
  };

  const loadFiles = async () => {
    setLoading(true);
    try {
      let url = `file-upload?action=list&page=${page}&limit=25`;
      if (search) url += `&search=${encodeURIComponent(search)}`;
      if (category) url += `&category=${encodeURIComponent(category)}`;
      const res = await apiGet(url);
      setFiles(res.rows || []);
      setTotal(res.total || 0);
      setTotalPages(res.total_pages || 0);
    } catch (e) {
      console.error('Failed to load files', e);
      setFiles([]);
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    setPage(1);
    loadFiles();
  };

  const handleUpload = async (e) => {
    e.preventDefault();
    const form = e.target;
    const fileInput = form.querySelector('input[type="file"]');
    if (!fileInput || !fileInput.files.length) {
      setMessage({ type: 'error', text: 'Please select a file to upload.' });
      return;
    }

    setLoading(true);
    setMessage(null);
    const formData = new FormData(form);
    formData.append('action', 'upload');

    try {
      const response = await fetch(apiUrl('file-upload?action=upload'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-CSRF-Token': getCsrfToken() },
        body: formData
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.message || 'Upload failed');
      
      setMessage({ type: 'success', text: `"${result.file_name}" uploaded successfully!` });
      form.reset();
      if (fileInputRef.current) fileInputRef.current.value = '';
      loadFiles();
      loadCategories();
    } catch (e) {
      setMessage({ type: 'error', text: e.body?.message || e.message || 'Upload failed.' });
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (file) => {
    if (!window.confirm(`Delete "${file.original_name}"? This cannot be undone.`)) return;
    setLoading(true);
    setMessage(null);
    try {
      await apiDelete('file-upload', { file_id: file.file_id });
      setMessage({ type: 'success', text: `"${file.original_name}" deleted.` });
      loadFiles();
      loadCategories();
    } catch (e) {
      setMessage({ type: 'error', text: e.body?.message || e.message || 'Delete failed.' });
    } finally {
      setLoading(false);
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

  const formatDate = (dateStr) => {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  };

  const getFileIcon = (type) => {
    if (!type) return 'bi-file-earmark';
    if (type.startsWith('image/')) return 'bi-file-earmark-image';
    if (type.includes('pdf')) return 'bi-file-earmark-pdf';
    if (type.includes('excel') || type.includes('spreadsheet') || type.includes('csv')) return 'bi-file-earmark-spreadsheet';
    if (type.includes('word') || type.includes('document')) return 'bi-file-earmark-word';
    if (type.includes('zip')) return 'bi-file-earmark-zip';
    return 'bi-file-earmark';
  };

  return (
    <div style={containerStyle}>
      <h2 style={headerStyle}>
        <i className="bi bi-cloud-upload" style={{ marginRight: '10px' }}></i>
        File Upload Manager
      </h2>

      {categories.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginBottom: '20px' }}>
          {categories.map(cat => (
            <div key={cat.category} style={{ ...cardStyle, textAlign: 'center', cursor: 'pointer', border: category === cat.category ? '2px solid #1a73e8' : '2px solid transparent' }}
                 onClick={() => { setCategory(category === cat.category ? '' : cat.category); setPage(1); }}>
              <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#1a73e8' }}>{cat.count}</div>
              <div style={{ fontSize: '0.8rem', color: '#666', textTransform: 'capitalize' }}>{cat.category}</div>
              <div style={{ fontSize: '0.7rem', color: '#999' }}>{cat.total_size_formatted}</div>
            </div>
          ))}
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
          <i className="bi bi-list-ul" style={{ marginRight: '5px' }}></i>Uploaded Files
        </button>
        <button style={tabBtnStyle(tab === 'upload')} onClick={() => setTab('upload')}>
          <i className="bi bi-cloud-upload-fill" style={{ marginRight: '5px' }}></i>Upload New File
        </button>
      </div>

      {tab === 'list' && (
        <div>
          <form onSubmit={handleSearch} style={{ display: 'flex', gap: '10px', marginBottom: '15px', flexWrap: 'wrap' }}>
            <input type="text" placeholder="Search file names..." value={search} onChange={e => setSearch(e.target.value)}
              style={{ flex: 1, minWidth: '200px', padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px' }} />
            <select value={category} onChange={e => { setCategory(e.target.value); setPage(1); }}
              style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}>
              <option value="">All Categories</option>
              <option value="documents">Documents</option>
              <option value="images">Images</option>
              <option value="reports">Reports</option>
              <option value="archives">Archives</option>
              <option value="general">General</option>
            </select>
            <button type="submit" style={{ padding: '8px 16px', background: '#1a73e8', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
              <i className="bi bi-search"></i> Search
            </button>
          </form>

          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>File</th>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Category</th>
                  <th style={thStyle}>Size</th>
                  <th style={thStyle}>Uploaded By</th>
                  <th style={thStyle}>Date</th>
                  <th style={thStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={7} style={{ ...tdStyle, padding: 0 }}><LoadingState label="Loading uploaded files..." compact /></td></tr>
                ) : files.length === 0 ? (
                  <tr><td colSpan={7} style={{ ...tdStyle, textAlign: 'center', padding: '30px', color: '#666' }}>No files uploaded yet.</td></tr>
                ) : files.map(file => (
                  <tr key={file.file_id}>
                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                      <i className={`bi ${getFileIcon(file.file_type)}`} style={{ fontSize: '1.5rem', color: '#1a73e8' }}></i>
                    </td>
                    <td style={tdStyle}>
                      <a href={file.url} target="_blank" rel="noopener noreferrer" style={{ color: '#1a73e8', textDecoration: 'none' }}>
                        {file.original_name}
                      </a>
                    </td>
                    <td style={tdStyle}>
                      <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '0.75rem', background: '#e8f0fe', color: '#1a73e8', textTransform: 'capitalize' }}>
                        {file.category}
                      </span>
                    </td>
                    <td style={tdStyle}>{file.file_size_formatted}</td>
                    <td style={tdStyle}>{file.user_name}</td>
                    <td style={tdStyle}>{formatDate(file.uploaded_at)}</td>
                    <td style={tdStyle}>
                      <button onClick={() => handleDelete(file)}
                        style={{ padding: '4px 10px', background: '#fce8e6', color: '#c5221f', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
                        <i className="bi bi-trash"></i>
                      </button>
                    </td>
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

      {tab === 'upload' && (
        <div style={cardStyle}>
          <h3 style={{ marginBottom: '15px', fontSize: '1.1rem' }}><i className="bi bi-cloud-upload-fill" style={{ marginRight: '8px' }}></i>Upload a File</h3>
          <form onSubmit={handleUpload}>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>Select File:</label>
              <input ref={fileInputRef} type="file" name="file" required
                style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px', width: '100%', maxWidth: '500px' }} />
              <div style={{ fontSize: '0.75rem', color: '#666', marginTop: '4px' }}>Max size: 10MB. Accepted: Images, PDF, DOC, XLS, CSV, TXT, ZIP</div>
            </div>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>Category:</label>
              <select name="category" style={{ padding: '8px', border: '1px solid #ddd', borderRadius: '4px', width: '100%', maxWidth: '300px' }}>
                <option value="general">General</option>
                <option value="documents">Documents</option>
                <option value="images">Images</option>
                <option value="reports">Reports</option>
                <option value="archives">Archives</option>
              </select>
            </div>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>Description (optional):</label>
              <textarea name="description" placeholder="Brief description of the file..." rows={2}
                style={{ padding: '8px 12px', border: '1px solid #ddd', borderRadius: '4px', width: '100%', maxWidth: '500px' }} />
            </div>
            <button type="submit" disabled={loading}
              style={{ padding: '10px 24px', background: '#34a853', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 500 }}>
              <i className="bi bi-cloud-upload" style={{ marginRight: '5px' }}></i>
              {loading ? 'Uploading...' : 'Upload File'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

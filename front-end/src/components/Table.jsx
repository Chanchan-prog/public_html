import React, { useMemo, useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import LoadingState from './LoadingState.jsx';

/**
 * Reusable table with client-side pagination and optional controlled
 * server-side pagination.
 */
function Table({
  columns = [],
  data = [],
  pageSize = 10,
  striped = true,
  hover = true,
  small = false,
  loading = false,
  emptyText = "No records found",
  rowKey = null,
  horizontalScroll = true,
  wrapCells = false,
  className = '',
  onRowClick = null,
  onRowMouseEnter = null,
  onRowMouseLeave = null,
  rowClassName = '',
  rowStyle = null,
  expandedRowKey = null,
  renderExpandedRow = null,
  serverPagination = false,
  totalItems = null,
  page = null,
  onPageChange = null,
}) {
  const [internalCurrentPage, setInternalCurrentPage] = useState(1);

  // Derive row key (Logic kept intact)
  const getRowKey = React.useMemo(() => {
    if (typeof rowKey === 'function') return rowKey;
    if (typeof rowKey === 'string' && rowKey.length) return (r) => r?.[rowKey];
    const common = ['attendance_id','record_id','id','user_id','room_id','schedule_id','key','_id'];
    return (r, idx) => {
      for (const k of common) {
        if (r && Object.prototype.hasOwnProperty.call(r, k) && (r[k] !== undefined && r[k] !== null)) return r[k];
      }
      try { return `${idx}-${String(r && r.date ? r.date : '')}-${String(r && r.time_in ? r.time_in : '')}`; } catch(e) { return idx; }
    };
  }, [rowKey]);

  // Loading is controlled by the page that owns the request. A timer cannot
  // know whether an API call has finished and previously caused false empty
  // states whenever a response took longer than the timer.
  const finalLoading = Boolean(loading);

  // Pagination Logic
  const total = serverPagination
    ? Math.max(0, Number(totalItems) || 0)
    : data.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requestedPage = serverPagination ? Number(page) || 1 : internalCurrentPage;
  const safeCurrentPage = Math.min(Math.max(requestedPage, 1), totalPages);

  const pageData = useMemo(() => {
    if (serverPagination) return data;
    const start = (safeCurrentPage - 1) * pageSize;
    return data.slice(start, start + pageSize);
  }, [data, safeCurrentPage, pageSize, serverPagination]);

  const goToPage = (page) => {
    const target = Math.min(Math.max(page, 1), totalPages);
    if (serverPagination) {
      if (typeof onPageChange === 'function' && target !== safeCurrentPage) onPageChange(target);
      return;
    }
    setInternalCurrentPage(target);
  };

  const paginationItems = useMemo(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);

    const pages = new Set([1, totalPages, safeCurrentPage]);
    if (safeCurrentPage <= 4) {
      for (let p = 2; p <= 5; p++) pages.add(p);
    } else if (safeCurrentPage >= totalPages - 3) {
      for (let p = totalPages - 4; p < totalPages; p++) pages.add(p);
    } else {
      pages.add(safeCurrentPage - 1);
      pages.add(safeCurrentPage + 1);
    }

    const sorted = Array.from(pages)
      .filter((page) => page >= 1 && page <= totalPages)
      .sort((a, b) => a - b);

    const items = [];
    sorted.forEach((page, idx) => {
      if (idx > 0 && page - sorted[idx - 1] > 1) items.push(`ellipsis-${idx}`);
      items.push(page);
    });
    return items;
  }, [safeCurrentPage, totalPages]);

  const shouldIgnoreRowClick = (event) => {
    const target = event && event.target;
    if (!target || typeof target.closest !== 'function') return false;
    return Boolean(
      target.closest('button, a, input, select, textarea, label, [data-no-row-click], .table-row-no-click')
    );
  };

  const handleRowClick = (row, idx, event) => {
    if (!onRowClick) return;
    if (event && event.defaultPrevented) return;
    if (shouldIgnoreRowClick(event)) return;
    onRowClick(row, idx, event);
  };

  // --- SUB-COMPONENTS ---

  // Kebab Menu (Styled with Tailwind) - renders dropdown into document.body so it sits outside the table
  function KebabMenu({ actions = [], row }) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef(null); // container around the button
    const menuRef = useRef(null); // actual menu DOM node in portal
    const [menuStyle, setMenuStyle] = useState(null);

    // close when clicking outside both the button container and the portal menu
    useEffect(() => {
      const onDocClick = (e) => {
        const withinBtn = containerRef.current && containerRef.current.contains(e.target);
        const withinMenu = menuRef.current && menuRef.current.contains(e.target);
        if (!withinBtn && !withinMenu) setOpen(false);
      };
      document.addEventListener('click', onDocClick);
      return () => document.removeEventListener('click', onDocClick);
    }, []);

    // compute menu placement when open; use fixed so it's outside scrolling containers
    useEffect(() => {
      if (!open) {
        setMenuStyle(null);
        return;
      }

      const btn = containerRef.current && containerRef.current.querySelector('button');
      if (!btn) return;

      const compute = () => {
        const btnRect = btn.getBoundingClientRect();
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        const estimatedItemH = 40;
        const naturalH = menuRef.current ? menuRef.current.scrollHeight : actions.length * estimatedItemH;
        const maxH = Math.floor(vh * 0.6);
        const menuH = Math.min(naturalH, maxH);

        // prefer below, otherwise place above
        const spaceBelow = vh - btnRect.bottom;
        let top;
        if (spaceBelow >= menuH + 8) top = btnRect.bottom + 6; else top = Math.max(6, btnRect.top - menuH - 6);

        // prefer left-aligned to button; fallback to right-aligned if not enough space
        const minW = 160;
        const preferLeft = btnRect.left + minW <= vw - 8;
        const style = { position: 'fixed', top: `${top}px`, zIndex: 99999, maxHeight: `${maxH}px`, overflowY: 'auto', minWidth: `${minW}px` };
        if (preferLeft) style.left = `${Math.max(8, btnRect.left)}px`; else style.right = `${Math.max(8, vw - btnRect.right)}px`;

        setMenuStyle(style);
      };

      // compute initially and on scroll/resize
      const raf = requestAnimationFrame(compute);
      window.addEventListener('resize', compute);
      window.addEventListener('scroll', compute, true);
      return () => {
        cancelAnimationFrame(raf);
        window.removeEventListener('resize', compute);
        window.removeEventListener('scroll', compute, true);
      };
    }, [open, actions.length]);

    const menuNode = open ? (
      <div
        ref={menuRef}
        className="card"
        style={{ ...(menuStyle || { position: 'fixed', top: 0, right: 0 }), boxShadow: '0 6px 18px rgba(0,0,0,0.12)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="list-group list-group-flush" style={{ padding: 0 }}>
          {actions.filter(a => !a.show || a.show(row)).map((a, i) => (
            <button
              key={i}
              type="button"
              className={`list-group-item list-group-item-action ${a.variant === 'danger' ? 'text-danger' : ''} ${a.variant === 'success' ? 'text-success' : ''}`}
              onClick={() => { setOpen(false); try { a.onClick(row); } catch (err) { console.error(err); } }}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    ) : null;

    return (
      <div ref={containerRef} className="relative d-inline-block text-left">
        <button
          type="button"
          className="btn btn-light btn-sm"
          style={{ width:36, height:36, padding:0, borderRadius:6 }}
          onClick={() => setOpen((s) => !s)}
          aria-haspopup="true"
          aria-expanded={open}
        >
          <span style={{ fontSize:18, lineHeight:'36px' }}>⋮</span>
        </button>

        {menuNode && ReactDOM.createPortal(menuNode, document.body)}
      </div>
    );
  }

  // --- MAIN RENDER ---

  return (
    <div className={`w-full ${className || ''}`.trim()}>
      <div className={`${horizontalScroll ? 'overflow-x-auto' : 'overflow-x-hidden'} border border-gray-200 rounded-lg shadow-sm bg-white`}>
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((col) => (
                <th 
                  key={col.key || col.label}
                  scope="col"
                  className={`px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wider ${small ? 'py-2' : 'py-3'} ${col.key === 'actions' ? 'text-right' : 'text-left'}`}
                  style={col.key === 'actions' ? { minWidth: 110, width: 110 } : undefined}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody className="bg-white divide-y divide-gray-200">
            {finalLoading ? (
              <tr>
                <td colSpan={columns.length} className="px-6 py-4 whitespace-nowrap">
                  <LoadingState label="Loading records..." compact />
                </td>
              </tr>
            ) : pageData.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-6 py-8 text-center text-sm text-gray-500 italic">
                  {emptyText}
                </td>
              </tr>
            ) : (
              pageData.map((row, idx) => {
                const rowId = getRowKey(row, idx);
                const globalIndex = (safeCurrentPage - 1) * pageSize + idx; // zero-based global index
                const resolvedRowClassName = typeof rowClassName === 'function'
                  ? rowClassName(row, idx, globalIndex)
                  : rowClassName;
                const resolvedRowStyle = typeof rowStyle === 'function'
                  ? rowStyle(row, idx, globalIndex)
                  : rowStyle;
                const hasExpandedRenderer = typeof renderExpandedRow === 'function';
                const isExpanded = hasExpandedRenderer
                  && expandedRowKey !== null
                  && expandedRowKey !== undefined
                  && String(rowId) === String(expandedRowKey);
                return (
                  <React.Fragment key={rowId}>
                    <tr
                      className={`transition-colors duration-150 
                        ${striped && idx % 2 !== 0 ? 'bg-gray-50' : 'bg-white'} 
                        ${hover ? 'hover:bg-green-50' : ''} ${onRowClick ? 'cursor-pointer' : ''} ${resolvedRowClassName || ''}`}
                      style={resolvedRowStyle || undefined}
                      onClick={onRowClick ? (e) => handleRowClick(row, idx, e) : undefined}
                      onMouseEnter={onRowMouseEnter ? (e) => onRowMouseEnter(row, idx, globalIndex, e) : undefined}
                      onMouseLeave={onRowMouseLeave ? (e) => onRowMouseLeave(row, idx, globalIndex, e) : undefined}
                    >
                      {columns.map((col) => (
                        <td
                          key={col.key || col.label}
                          className={`px-4 text-sm text-gray-700 ${small ? 'py-2' : 'py-3.5'} ${col.key === 'actions' ? 'text-right' : (wrapCells ? 'whitespace-normal break-words align-top' : 'whitespace-nowrap')}`}
                          style={col.key === 'actions' ? { minWidth: 110 } : undefined}
                          data-label={typeof col.label === 'string' ? col.label : (col.key || '')}
                          data-col={col.key || ''}
                        >
                          {(() => {
                            // allow actions to be either an array or a function returning an array
                            const actions = typeof col.actions === 'function' ? col.actions(row) : col.actions;
                            if (col.render) {
                              return (col.render.length === 1) ? col.render(row) : col.render(row, idx, globalIndex);
                            }
                            if (actions && Array.isArray(actions)) return <KebabMenu actions={actions} row={row} />;
                            return row[col.key];
                          })()}
                        </td>
                      ))}
                    </tr>
                    {isExpanded ? (
                      <tr className="bg-gray-50">
                        <td colSpan={columns.length} className="px-4 py-3">
                          {renderExpandedRow(row, idx, globalIndex)}
                        </td>
                      </tr>
                    ) : null}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Controls */}
      {totalPages > 1 && (
        <div className="flex flex-col sm:flex-row justify-between items-center gap-4 mt-4 px-2">
          <div className="text-sm text-gray-500">
            <span className="inline-flex items-center gap-3 px-3 py-1 bg-gray-100 rounded-full border border-gray-200">
              <span className="text-gray-600">Showing</span>
              <span className="text-sm text-gray-800 font-medium">{total === 0 ? 0 : (safeCurrentPage - 1) * pageSize + 1}</span>
              <span className="text-gray-400">to</span>
              <span className="text-sm text-gray-800 font-medium">{Math.min(safeCurrentPage * pageSize, total)}</span>
              <span className="text-gray-400">of</span>
              <span className="text-sm text-gray-800 font-medium">{total}</span>
              <span className="text-gray-600">entries</span>
            </span>
          </div>

          <nav aria-label="Pagination" className="max-w-full overflow-x-auto pb-1">
            <ul className="inline-flex items-center gap-1 rounded-md">
              {/* Previous */}
              <li>
                <button
                  onClick={() => goToPage(safeCurrentPage - 1)}
                  disabled={safeCurrentPage === 1}
                  className={`px-3 py-2 ml-0 leading-tight text-gray-500 bg-white border border-gray-300 rounded-l-lg hover:bg-gray-100 hover:text-gray-700 transition-colors
                    ${safeCurrentPage === 1 ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  Previous
                </button>
              </li>

              {/* Page Numbers */}
              {paginationItems.map((item) => {
                if (typeof item === 'string') {
                  return (
                    <li key={item}>
                      <span className="inline-flex items-center justify-center px-2 py-2 text-gray-400">...</span>
                    </li>
                  );
                }
                const page = item;
                const isActive = page === safeCurrentPage;
                return (
                  <li key={page}>
                    <button
                      onClick={() => goToPage(page)}
                      className={`px-3 py-2 leading-tight border rounded-md transition-colors
                        ${isActive 
                          ? 'z-10 text-white bg-green-600 border-green-600 hover:bg-green-700 hover:text-white' 
                          : 'text-gray-500 bg-white border-gray-300 hover:bg-gray-100 hover:text-gray-700'}`}
                      style={{ minWidth: 40 }}
                    >
                      {page}
                    </button>
                  </li>
                );
              })}

              {/* Next */}
              <li>
                <button
                  onClick={() => goToPage(safeCurrentPage + 1)}
                  disabled={safeCurrentPage === totalPages}
                  className={`px-3 py-2 leading-tight text-gray-500 bg-white border border-gray-300 rounded-r-lg hover:bg-gray-100 hover:text-gray-700 transition-colors
                    ${safeCurrentPage === totalPages ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  Next
                </button>
              </li>
            </ul>
          </nav>
        </div>
      )}
    </div>
  );
}

export default Table;

import React from 'react';
import '../styles/MasterDataPage.css';

export function MasterPageHeader({ eyebrow = 'Administration', title, description, action = null }) {
  return (
    <div className="mdp-header">
      <div className="mdp-header-copy">
        <div className="mdp-eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="mdp-header-actions">
        {action}
      </div>
    </div>
  );
}

export function MasterStats({ items = [], loading = false }) {
  return (
    <div className="mdp-stats" aria-busy={loading}>
      {items.map((item, index) => {
        const Component = item.onClick ? 'button' : 'div';
        return (
        <Component
          type={item.onClick ? 'button' : undefined}
          onClick={item.onClick}
          aria-pressed={item.onClick ? Boolean(item.active) : undefined}
          className={`mdp-stat mdp-stat-${item.tone || ['green', 'blue', 'amber'][index % 3]}${item.onClick ? ' mdp-stat-clickable' : ''}${item.active ? ' is-active' : ''}`}
          key={item.label}
        >
          <div className="mdp-stat-icon" aria-hidden="true">{item.icon || '•'}</div>
          <div className="mdp-stat-copy">
            <div className="mdp-stat-label">{item.label}</div>
            <div className="mdp-stat-value" aria-live="polite">{loading ? '—' : item.value}</div>
            <div className="mdp-stat-help">{item.help}</div>
          </div>
        </Component>
      );})}
    </div>
  );
}

export function MasterToolbar({ children }) {
  return <div className="mdp-toolbar">{children}</div>;
}

export function MasterSearch({ value, onChange, placeholder = 'Search records…' }) {
  return (
    <label className="mdp-search">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path strokeLinecap="round" d="m20 20-3.5-3.5" /></svg>
      <input value={value} onChange={onChange} placeholder={placeholder} aria-label={placeholder} />
    </label>
  );
}

export function MasterResults({ title, count, description = '', loading = false, children }) {
  return (
    <div className="mdp-results" aria-busy={loading}>
      <div className="mdp-results-head">
        <div>
          <h2>{title}</h2>
          {description ? <p>{description}</p> : null}
        </div>
        <span className="mdp-count" aria-live="polite">{loading ? 'Loading…' : `${count} ${Number(count) === 1 ? 'record' : 'records'}`}</span>
      </div>
      <div className="mdp-results-body">{children}</div>
    </div>
  );
}

export function MasterSelect({ label, value, onChange, children, disabled = false }) {
  return (
    <label className="mdp-filter">
      <span>{label}</span>
      <select value={value} onChange={onChange} disabled={disabled}>{children}</select>
    </label>
  );
}

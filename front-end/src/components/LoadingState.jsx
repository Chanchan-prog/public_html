import React from 'react';

export default function LoadingState({
  label = 'Loading data...',
  compact = false,
  inline = false,
  className = '',
}) {
  const classes = [
    'app-data-loading',
    compact ? 'is-compact' : '',
    inline ? 'is-inline' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className={classes} role="status" aria-live="polite">
      <span className="app-data-loading-spinner" aria-hidden="true" />
      {label ? <span className="app-data-loading-label">{label}</span> : null}
    </div>
  );
}

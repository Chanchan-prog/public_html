import React from 'react';

function StatisticsBoxs({
  items = [],
  activeKey = null,
  onSelect = null,
  className = ''
}) {
  const visibleItems = Array.isArray(items) ? items.filter(i => !i?.hidden) : [];
  const colClass = visibleItems.length >= 4
    ? 'xl:grid-cols-4'
    : visibleItems.length === 3
      ? 'xl:grid-cols-3'
      : visibleItems.length === 2
        ? 'xl:grid-cols-2'
        : 'xl:grid-cols-1';

  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 ${colClass} gap-4 ${className || ''}`}>
      {visibleItems.map((item) => {
        const key = item.key ?? item.label;
        const isActive = activeKey !== null && activeKey !== undefined
          ? String(activeKey) === String(item.key)
          : !!item.active;
        const isDisabled = !!item.disabled;
        const canClick = !isDisabled && (typeof item.onClick === 'function' || typeof onSelect === 'function');

        const handleClick = () => {
          if (!canClick) return;
          if (typeof item.onClick === 'function') item.onClick(item);
          else if (typeof onSelect === 'function' && item.key !== undefined) onSelect(item.key, item);
        };

        return (
          <button
            key={key}
            type="button"
            onClick={handleClick}
            disabled={isDisabled}
            aria-pressed={isActive}
            className={`group relative w-full text-left rounded-2xl border p-4 transition-all shadow-sm focus:outline-none focus:ring-2 focus:ring-green-200
              ${isActive ? 'border-green-600 bg-green-50' : 'border-gray-200 bg-white hover:border-green-300 hover:shadow-md'}
              ${isDisabled ? 'opacity-60 cursor-not-allowed' : (canClick ? 'cursor-pointer' : 'cursor-default')}`}
          >
            <div className={`absolute left-0 top-0 h-full w-1 rounded-l-2xl ${isActive ? 'bg-green-600' : 'bg-green-200 group-hover:bg-green-400'}`}></div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-green-700">{item.label}</div>
                <div className="mt-1 text-2xl font-bold text-gray-900">{item.value ?? 0}</div>
                {item.subLabel ? (
                  <div className="mt-1 text-xs text-gray-500">{item.subLabel}</div>
                ) : null}
              </div>
              {item.icon ? (
                <div className={`flex h-12 w-12 items-center justify-center rounded-xl ${isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-green-600'}`}>
                  {item.icon}
                </div>
              ) : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export default StatisticsBoxs;

import React from 'react';

/**
 * Page-owned loading skeletons that are safe to load with the application shell.
 * A page and its lazy-route fallback import the same component, which keeps their
 * geometry identical without making different pages share one generic design.
 */
export function DashboardLoadingSkeleton() {
  return (
    <div className="mx-auto max-w-[1450px] px-4 py-5 md:px-6" role="status" aria-label="Loading Dashboard">
      <div className="animate-pulse space-y-4">
        <div className="h-20 rounded-xl border border-slate-200 bg-white" />
        <div className="grid gap-3 sm:grid-cols-3">
          {[1, 2, 3].map((item) => <div key={item} className="h-24 rounded-xl bg-slate-100" />)}
        </div>
        <div className="h-80 rounded-xl bg-slate-100" />
      </div>
      <span className="sr-only">Loading Dashboard.</span>
    </div>
  );
}

export function MyDashboardLoadingSkeleton() {
  return (
    <div className="mx-auto max-w-[1350px] animate-pulse space-y-4 px-3 py-4 sm:px-4 sm:py-5 md:px-6" role="status" aria-label="Loading My Dashboard">
      <div className="h-20 rounded-xl bg-slate-100" />
      <div className="grid gap-3 sm:grid-cols-3">
        {[1, 2, 3].map((item) => <div key={item} className="h-24 rounded-xl bg-slate-100" />)}
      </div>
      <div className="h-80 rounded-xl bg-slate-100" />
      <span className="sr-only">Loading My Dashboard.</span>
    </div>
  );
}

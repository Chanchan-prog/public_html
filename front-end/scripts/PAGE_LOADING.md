# On-demand page loading

All 35 routed pages use descriptors in src/App.jsx. APP_IMPORT_MODULE uses the existing browser JSX compiler and content-versioned requests. Concurrent requests and shared modules are deduplicated. Page source and optional libraries load together; the page mounts after both are ready.

Returning to a loaded page reuses its module but still mounts normally and runs existing data-fetching behavior. No business data caching is added. First visits can show Loading page; failures show Try Again. Navigation away prevents stale loading updates.

Existing CSS stays eager in its original order to preserve appearance. Routes, permission guards and shell are unchanged. No database changes or manual build commands are required. Automatic generated-CSS fallback remains available.

Checks: HTTP generated CSS and versioned sources; startup 12 shared source modules with no page JavaScript; all 35 page graphs compile and parse; shared requests, reuse, network retry, path restriction and library readiness gate. Route/permission/shell comparison against backup passes with normalized line endings.

Interactive browser checks remain: sign in; visit Home, Users, Class Schedule, Reports, Attendance and 3D Building; navigate back; verify imports, exports and scanning. Network should show page JSX only when opened.

Backup: C:/Users/Administrator/AppData/Local/CodexBackups/3D1.3xxsc-page-loading-20260908-211110. Preserve unrelated work when reverting.

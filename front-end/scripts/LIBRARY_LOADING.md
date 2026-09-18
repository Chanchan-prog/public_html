# Page-specific vendor loading

The initial HTML loads React, ReactDOM, Babel, and SweetAlert. `src/services/vendorLibraries.js` loads other local scripts with content-version URLs, shares concurrent requests, and permits retry after a failure. `VendorPage` in `src/App.jsx` waits for the resolved page's dependencies before mounting that page. Fast navigation cancels stale UI updates, not shared downloads.

Dependencies by page:

- Users, Class Schedule, Subject Offerings: SheetJS.
- Reports: D3, SheetJS, html2pdf.
- 3D Building (including its attendance exports): Three.js and its existing loaders, fflate, SheetJS, html2pdf.
- Attendance: html5-qrcode.
- Other pages: no additional groups currently required.

Three loads before its extensions; NURBSUtils loads before NURBSCurve; FBXLoader loads after fflate and the NURBS components. The model-viewer script was removed from initial loading because no current source page uses that custom element. Its vendor file remains available.

The first visit to a dependent page can display a loading message. Once scripts are loaded, subsequent pages reuse their globals. Failed requests show a retry button. Page source also loads on demand; see PAGE_LOADING.md. Dependencies load per page, not per button action.

No manual build or watcher is required. When adding a page that uses a vendor global, add its library group to the page descriptor in `src/App.jsx` before using that global during render/effects. Imports must not access optional vendor globals at module top level, because source modules are evaluated before the page gate.

Verification: deduplication, versioned URLs, loaded reuse, failed-load retry, dependency ordering, actual Three vendor initialization, frontend compilation, full module graph parsing, and HTTP entry checks. Startup script tags fell from 18 to 4; gzip estimates for those scripts fell from 1.96 MB to 0.72 MB, excluding page-source downloads and subsequent page libraries. No claim of total page-speed improvement is made. Interactive browser testing of charts, exports, imports, scanning, and 3D remains necessary.

Backups: `C:\Users\Administrator\AppData\Local\CodexBackups\3D1.3xxsc-library-loading-20260908-210736`.

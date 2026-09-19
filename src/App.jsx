import React from "react";
import { AuthContext, AuthProvider } from "./context/AuthContext.jsx";
import Navbar from "./components/Navbar.jsx";
import { DashboardLoadingSkeleton, MyDashboardLoadingSkeleton } from "./components/PageLoadingSkeletons.jsx";
import { apiPost } from "./services/api.js";
import { canAccessModule, getPermissionFromRoute } from "./utils/moduleAccess.js";
import { ensureVendorLibraries } from './services/vendorLibraries.js';

// Keep the existing stylesheet cascade stable across navigation.
import "./styles/MasterDataPage.css";
import "./pages/Report/index.css";
import "./pages/ThreeDBuilding/Index.css";
import "./pages/System-logs/index.css";
import "./pages/Settings/Index.css";

// Stable page descriptors preserve the existing route-selection rules.
const AttendancePage = { source: "../src/pages/Attendance/Index.jsx", libraries: ["scanner"], title: "Attendance Scanner", loadingLayout: "scanner" };
const AttedanceManagement = { source: "../src/pages/AttedanceManagement/Index.jsx", libraries: [], title: "Attendance Records", loadingLayout: "records" };
const DashboardPage = { source: "../src/pages/Dashboard/Index.jsx", libraries: [], title: "Dashboard", loadingLayout: "dashboard-operations" };
const LoginPage = { source: "../src/pages/Login/Index.jsx", libraries: [], title: "Sign In", loadingLayout: "login" };
const HomeIndex = { source: "../src/pages/Home/Index.jsx", libraries: [], title: "Home", loadingLayout: "home" };
const BuildingIndex = { source: "../src/pages/Building/Index.jsx", libraries: [], title: "Buildings", loadingLayout: "master", loadingStats: 3, loadingFilters: 2 };
const ThreeDBuildingIndex = { source: "../src/pages/ThreeDBuilding/Index.jsx", libraries: ["three", "spreadsheet", "pdf"], title: "3D Campus Map", loadingLayout: "map" };
const RoomIndex = { source: "../src/pages/Room/Index.jsx", libraries: [], title: "Rooms", loadingLayout: "master", loadingStats: 3, loadingFilters: 4 };
const UserIndex = { source: "../src/pages/User/Index.jsx", libraries: ["spreadsheet"], title: "Users", loadingLayout: "master", loadingStats: 4, loadingFilters: 4 };
const ProgramIndex = { source: "../src/pages/Program/Index.jsx", libraries: [], title: "Programs", loadingLayout: "master", loadingStats: 4, loadingFilters: 3 };
const DepartmentIndex = { source: "../src/pages/Department/Index.jsx", libraries: [], title: "Departments", loadingLayout: "master", loadingStats: 4, loadingFilters: 2 };
const FloorIndex = { source: "../src/pages/Floor/Index.jsx", libraries: [], title: "Floors", loadingLayout: "master", loadingStats: 3, loadingFilters: 3 };
const SectionIndex = { source: "../src/pages/Section/Index.jsx", libraries: [], title: "Sections", loadingLayout: "master", loadingStats: 3, loadingFilters: 4 };
const SubjectIndex = { source: "../src/pages/Subject/Index.jsx", libraries: [], title: "Subjects", loadingLayout: "master", loadingStats: 3, loadingFilters: 4 };
const ClassScheduleIndex = { source: "../src/pages/ClassSchedule/Index.jsx", libraries: ["spreadsheet"], title: "Class Schedules", loadingLayout: "control-center" };
const SemesterIndex = { source: "../src/pages/Semester/Index.jsx", libraries: [], title: "Semesters", loadingLayout: "legacy-table" };
const SubjectOfferingIndex = { source: "../src/pages/SubjectOffering/Index.jsx", libraries: ["spreadsheet"], title: "Subject Offerings", loadingLayout: "legacy-table" };
const SchoolIndex = { source: "../src/pages/School/Index.jsx", libraries: [], title: "School Information", loadingLayout: "legacy-table" };
const FileLeave = { source: "../src/pages/File_leave/index.jsx", libraries: [], title: "File Leave", loadingLayout: "master", loadingStats: 4, loadingFilters: 3 };
const LeaveApproval = { source: "../src/pages/Leave_approval/index.jsx", libraries: [], title: "Leave Approval", loadingLayout: "legacy-table" };
const Penalties = { source: "../src/pages/Penalties/Index.jsx", libraries: [], title: "Penalties", loadingLayout: "penalties" };
const Substitute = { source: "../src/pages/Substitute/Index.jsx", libraries: [], title: "Substitutions", loadingLayout: "master", loadingStats: 4, loadingFilters: 4 };
const MyAttendance = { source: "../src/pages/Teaching_Schedule/index.jsx", libraries: [], title: "Teaching Schedule", loadingLayout: "weekly-schedule" };
const ReportIndex = { source: "../src/pages/Report/index.jsx", libraries: ["charts", "spreadsheet", "pdf"], title: "Reports", loadingLayout: "report" };
const AttendanceAudit = { source: "../src/pages/Attedance_Audit/index.jsx", libraries: [], title: "Attendance Adjustment Logs", loadingLayout: "audit" };
const SystemLogs = { source: "../src/pages/System-logs/index.jsx", libraries: [], title: "Audit Trail", loadingLayout: "audit" };
const AttendanceHistory = { source: "../src/pages/Attendance_History/index.jsx", libraries: [], title: "Attendance History", loadingLayout: "history" };
const SchoolYearIndex = { source: "../src/pages/School_year/index.jsx", libraries: [], title: "School Year", loadingLayout: "master", loadingStats: 3, loadingFilters: 2 };
const RequestEditIndex = { source: "../src/pages/Request_Edit/index.jsx", libraries: [], title: "Requested Edits", loadingLayout: "request-tracker" };
const AttendanceEditRequestPage = { source: "../src/pages/Attendance_Edit_Request/index.jsx", libraries: [], title: "Attendance Edit Requests", loadingLayout: "request-review" };
const GeneralSettingsIndex = { source: "../src/pages/Settings/Index.jsx", libraries: [], title: "General Settings", loadingLayout: "settings" };
const MyDashboardPage = { source: "../src/pages/My_Dashboard/Index.jsx", libraries: [], title: "My Dashboard", loadingLayout: "dashboard-personal" };
const NotificationIndex = { source: "../src/pages/Notification/Index.jsx", libraries: [], title: "Notifications", loadingLayout: "master", loadingStats: 4, loadingFilters: 2 };
const DataArchiveIndex = { source: "../src/pages/DataArchive/Index.jsx", libraries: [], title: "Data Archive", loadingLayout: "archive", loadingAction: false };
const FileUploadIndex = { source: "../src/pages/FileUpload/Index.jsx", libraries: [], title: "File Manager", loadingLayout: "upload", loadingAction: false };
const CalendarEventsIndex = { source: "../src/pages/CalendarEvents/Index.jsx", libraries: [], title: "Holidays & Events", loadingLayout: "master", loadingStats: 2, loadingFilters: 2 };

const loadedPages = new Map();
const loadingPages = new Map();
function loadPage(page) {
  if (loadedPages.has(page)) return Promise.resolve(loadedPages.get(page));
  if (loadingPages.has(page)) return loadingPages.get(page);
  // Start page source and vendors together; mount only after both are ready.
  const promise = Promise.all([
    window.APP_IMPORT_MODULE(page.source),
    ensureVendorLibraries(page.libraries),
  ]).then(([module]) => {
    if (typeof module.default !== 'function') throw new Error('Page could not start.');
    loadedPages.set(page, module.default);
    return module.default;
  });
  loadingPages.set(page, promise);
  promise.then(() => loadingPages.delete(page), () => loadingPages.delete(page));
  return promise;
}

function LoadingBlock({ className = '' }) {
  return <span className={`app-route-loading-block ${className}`.trim()} aria-hidden="true"></span>;
}

function RoutePageLoading({ page }) {
  const layout = page?.loadingLayout || 'table';
  const title = page?.title || 'Page';
  let preview;

  if (layout === 'dashboard-operations' || layout === 'dashboard-personal') {
    return layout === 'dashboard-personal'
      ? <MyDashboardLoadingSkeleton />
      : <DashboardLoadingSkeleton />;
  }

  if (layout === 'master') {
    const statCount = Math.max(1, Number(page?.loadingStats || 3));
    const filterCount = Math.max(1, Number(page?.loadingFilters || 2));
    preview = (
      <>
        <div className="app-route-loading-master-stats">
          {Array.from({ length: statCount }, (_, item) => <LoadingBlock key={item} className="is-master-stat" />)}
        </div>
        <div className="app-route-loading-master-toolbar">
          {Array.from({ length: filterCount }, (_, item) => <LoadingBlock key={item} className={item === 0 ? 'is-master-search' : 'is-master-filter'} />)}
        </div>
        <div className="app-route-loading-master-results">
          <LoadingBlock className="is-master-results-head" />
          {[1, 2, 3, 4, 5, 6].map((item) => <LoadingBlock key={item} className="is-master-row" />)}
        </div>
      </>
    );
  } else if (layout === 'home') {
    preview = (
      <>
        <LoadingBlock className="is-hero" />
        <LoadingBlock className="is-home-next" />
        <div className="app-route-loading-cards">
          {[1, 2, 3].map((item) => <LoadingBlock key={item} className="is-card" />)}
        </div>
      </>
    );
  } else if (layout === 'scanner') {
    preview = (
      <div className="app-route-loading-scanner-grid">
        <div className="app-route-loading-scan-frame"><LoadingBlock className="is-scan-target" /></div>
        <div className="app-route-loading-stack"><LoadingBlock className="is-line is-wide" /><LoadingBlock className="is-line" /><LoadingBlock className="is-panel" /></div>
      </div>
    );
  } else if (layout === 'map') {
    preview = (
      <>
        <div className="app-route-loading-map-stats">{[1, 2, 3, 4].map((item) => <LoadingBlock key={item} className="is-map-stat" />)}</div>
        <div className="app-route-loading-map-filters">{[1, 2, 3, 4, 5].map((item) => <LoadingBlock key={item} className="is-map-filter" />)}</div>
        <div className="app-route-loading-map-layout">
          <div className="app-route-loading-map"><div className="app-route-loading-map-tools"><LoadingBlock className="is-pill" /><LoadingBlock className="is-pill" /></div><LoadingBlock className="is-map-canvas" /></div>
          <LoadingBlock className="is-map-sidebar" />
        </div>
      </>
    );
  } else if (layout === 'records') {
    preview = (
      <>
        <LoadingBlock className="is-records-hero" />
        <div className="app-route-loading-metrics">
          {[1, 2, 3, 4].map((item) => <LoadingBlock key={item} className="is-record-metric" />)}
        </div>
        <div className="app-route-loading-filters"><LoadingBlock className="is-field" /><LoadingBlock className="is-field" /><LoadingBlock className="is-field" /></div>
        <div className="app-route-loading-table"><LoadingBlock className="is-table-head" />{[1, 2, 3, 4, 5].map((item) => <LoadingBlock key={item} className="is-table-row" />)}</div>
      </>
    );
  } else if (layout === 'control-center') {
    preview = (
      <>
        <LoadingBlock className="is-control-hero" />
        <div className="app-route-loading-control-panels"><LoadingBlock className="is-control-panel" /><LoadingBlock className="is-control-panel" /></div>
        <LoadingBlock className="is-control-toolbar" />
        <div className="app-route-loading-table"><LoadingBlock className="is-table-head" />{[1, 2, 3, 4, 5].map((item) => <LoadingBlock key={item} className="is-table-row" />)}</div>
      </>
    );
  } else if (layout === 'penalties') {
    preview = (
      <>
        <LoadingBlock className="is-penalty-header" />
        <div className="app-route-loading-penalty-metrics">{[1, 2, 3, 4].map((item) => <LoadingBlock key={item} className="is-penalty-metric" />)}</div>
        <LoadingBlock className="is-penalty-note" />
        <div className="app-route-loading-table"><LoadingBlock className="is-table-head" />{[1, 2, 3, 4, 5].map((item) => <LoadingBlock key={item} className="is-table-row" />)}</div>
      </>
    );
  } else if (layout === 'request-tracker' || layout === 'request-review') {
    preview = (
      <>
        <LoadingBlock className="is-request-hero" />
        {layout === 'request-review' ? <div className="app-route-loading-request-metrics">{[1, 2, 3, 4].map((item) => <LoadingBlock key={item} className="is-request-metric" />)}</div> : null}
        {layout === 'request-review' ? <LoadingBlock className="is-request-filters" /> : null}
        <div className="app-route-loading-table"><LoadingBlock className="is-table-head" />{[1, 2, 3, 4, 5].map((item) => <LoadingBlock key={item} className="is-table-row" />)}</div>
      </>
    );
  } else if (layout === 'report') {
    preview = (
      <>
        <LoadingBlock className="is-report-filter-card" />
        <div className="app-route-loading-report-metrics">{[1, 2, 3, 4].map((item) => <LoadingBlock key={item} className="is-report-metric" />)}</div>
        <div className="app-route-loading-report-grid"><LoadingBlock className="is-chart" /><LoadingBlock className="is-chart" /></div>
        <div className="app-route-loading-table"><LoadingBlock className="is-table-head" />{[1, 2, 3, 4].map((item) => <LoadingBlock key={item} className="is-table-row" />)}</div>
      </>
    );
  } else if (layout === 'weekly-schedule') {
    preview = (
      <>
        <LoadingBlock className="is-weekly-hero" />
        <div className="app-route-loading-week-grid">{[1, 2, 3, 4, 5, 6, 7].map((item) => <LoadingBlock key={item} className="is-week-day" />)}</div>
      </>
    );
  } else if (layout === 'schedule' || layout === 'calendar') {
    preview = (
      <>
        <div className="app-route-loading-filters"><LoadingBlock className="is-field" /><LoadingBlock className="is-field" /><LoadingBlock className="is-button" /></div>
        <div className="app-route-loading-calendar">
          {[1, 2, 3, 4, 5].map((item) => <LoadingBlock key={item} className="is-calendar-column" />)}
        </div>
      </>
    );
  } else if (layout === 'settings') {
    preview = (
      <>
        <LoadingBlock className="is-settings-hero" />
        <div className="app-route-loading-settings-metrics">{[1, 2, 3, 4].map((item) => <LoadingBlock key={item} className="is-settings-metric" />)}</div>
        <div className="app-route-loading-settings-groups"><LoadingBlock className="is-settings-group" /><LoadingBlock className="is-settings-group" /></div>
      </>
    );
  } else if (layout === 'history') {
    preview = (
      <>
        <LoadingBlock className="is-history-summary" />
        <div className="app-route-loading-history-calendar"><LoadingBlock className="is-history-weekdays" /><LoadingBlock className="is-history-month" /></div>
        <LoadingBlock className="is-history-legend" />
      </>
    );
  } else if (layout === 'audit') {
    preview = (
      <>
        <div className="app-route-loading-audit-metrics">{[1, 2, 3, 4].map((item) => <LoadingBlock key={item} className="is-audit-metric" />)}</div>
        <LoadingBlock className="is-audit-filters" />
        <div className="app-route-loading-table"><LoadingBlock className="is-table-head" />{[1, 2, 3, 4, 5].map((item) => <LoadingBlock key={item} className="is-table-row" />)}</div>
      </>
    );
  } else if (layout === 'notifications' || layout === 'requests') {
    preview = (
      <div className={`app-route-loading-list is-${layout}`}>
        {[1, 2, 3, 4].map((item) => (
          <div className="app-route-loading-list-item" key={item}>
            <LoadingBlock className="is-avatar" />
            <span className="app-route-loading-list-copy"><LoadingBlock className="is-line is-wide" /><LoadingBlock className="is-line" /></span>
          </div>
        ))}
      </div>
    );
  } else if (layout === 'upload') {
    preview = <><div className="app-route-loading-file-categories">{[1, 2, 3, 4].map((item) => <LoadingBlock key={item} className="is-file-category" />)}</div><LoadingBlock className="is-file-tabs" /><div className="app-route-loading-table"><LoadingBlock className="is-table-head" />{[1, 2, 3, 4, 5].map((item) => <LoadingBlock key={item} className="is-table-row" />)}</div></>;
  } else if (layout === 'archive') {
    preview = <><div className="app-route-loading-archive">{[1, 2, 3, 4].map((item) => <LoadingBlock key={item} className="is-archive-box" />)}</div><LoadingBlock className="is-file-tabs" /><div className="app-route-loading-table"><LoadingBlock className="is-table-head" />{[1, 2, 3, 4, 5].map((item) => <LoadingBlock key={item} className="is-table-row" />)}</div></>;
  } else if (layout === 'login') {
    preview = <div className="app-route-loading-login"><LoadingBlock className="is-login-brand" /><div className="app-route-loading-stack"><LoadingBlock className="is-line is-wide" /><LoadingBlock className="is-field" /><LoadingBlock className="is-field" /><LoadingBlock className="is-button" /></div></div>;
  } else if (layout === 'form') {
    preview = <div className="app-route-loading-form"><LoadingBlock className="is-field" /><LoadingBlock className="is-field" /><LoadingBlock className="is-field" /><LoadingBlock className="is-button" /></div>;
  } else {
    preview = (
      <>
        <div className="app-route-loading-filters"><LoadingBlock className="is-field" /><LoadingBlock className="is-field" /><LoadingBlock className="is-button" /></div>
        <div className="app-route-loading-table">
          <LoadingBlock className="is-table-head" />
          {[1, 2, 3, 4, 5].map((item) => <LoadingBlock key={item} className="is-table-row" />)}
        </div>
      </>
    );
  }

  return (
    <section className={`app-route-page-loading layout-${layout}`} role="status" aria-live="polite" aria-label={`Loading ${title}`}>
      <header className="app-route-loading-header">
        <div>
          <LoadingBlock className="is-heading-eyebrow" />
          <h1>{title}</h1>
          <LoadingBlock className="is-heading-description" />
        </div>
        {layout === 'report' ? (
          <div className="app-route-loading-header-actions">
            {[1, 2, 3].map((item) => <LoadingBlock key={item} className="is-header-action" />)}
          </div>
        ) : page?.loadingAction === false ? null : <LoadingBlock className="is-header-action" />}
      </header>
      <div className="app-route-loading-preview">{preview}</div>
      <span className="sr-only">Loading {title}.</span>
    </section>
  );
}

function VendorPage({ View: page, isInitialLoad = false, onPageReady }) {
  const [state, setState] = React.useState(() => ({
    resolvedPage: loadedPages.has(page) ? page : null,
    error: '',
    errorPage: null,
  }));
  const [retry, setRetry] = React.useState(0);
  React.useEffect(() => {
    if (loadedPages.has(page)) {
      setState({ resolvedPage: page, error: '', errorPage: null });
      return undefined;
    }
    let active = true;
    // Keep the current page mounted while the next page module downloads.
    // The destination then renders its own exact loading layout.
    setState((current) => ({ ...current, error: '', errorPage: null }));
    loadPage(page).then(() => {
      if (active) setState({ resolvedPage: page, error: '', errorPage: null });
    }).catch((error) => {
      console.error('[navigation] Page failed to load', {
        page: page?.title || 'Page',
        code: error?.code || 'page_load_failed',
        error,
      });
      if (active) {
        setState((current) => ({
          ...current,
          error: 'Unable to load this page. Check your connection and try again.',
          errorPage: page,
        }));
      }
    });
    return () => { active = false; };
  }, [page, retry]);
  const TargetComponent = loadedPages.get(page);
  const PreviousComponent = state.resolvedPage
    ? loadedPages.get(state.resolvedPage)
    : null;

  React.useEffect(() => {
    if (TargetComponent && typeof onPageReady === 'function') onPageReady();
  }, [TargetComponent, onPageReady]);

  if (TargetComponent) return <TargetComponent />;
  if (state.errorPage === page && state.error) return (
    <div className="app-page-error" role="alert" aria-live="assertive">
      <div className="app-page-error-card">
        <span className="app-page-error-icon" aria-hidden="true">
          <i className="bi bi-cloud-slash" />
        </span>
        <div className="app-page-error-copy">
          <div className="app-page-error-eyebrow">Page unavailable</div>
          <h1>We couldn&apos;t open {page?.title || 'this page'}</h1>
          <p>{state.error}</p>
        </div>
        <div className="app-page-error-actions">
          <button type="button" className="app-page-error-primary" onClick={() => setRetry(value => value + 1)}>
            <i className="bi bi-arrow-clockwise" aria-hidden="true" />
            Try Again
          </button>
          <button type="button" className="app-page-error-secondary" onClick={() => { window.location.hash = '#/home'; }}>
            <i className="bi bi-house" aria-hidden="true" />
            Go to Home
          </button>
        </div>
        <p className="app-page-error-help">If this keeps happening, check your connection or contact the system administrator.</p>
      </div>
    </div>
  );

  if (PreviousComponent) return <PreviousComponent />;

  // The full-screen animated loader belongs only to the initial document load.
  // This small fallback is only reachable when no previous page can be retained.
  if (!isInitialLoad) {
    return (
      <div className="app-route-navigation-status" role="status" aria-live="polite">
        Opening page…
      </div>
    );
  }

  return (
    <div className="app-route-resolving" role="status" aria-live="polite" aria-label="Loading">
      <div className="app-route-resolving-mark" aria-hidden="true"></div>
    </div>
  );
}

function resolveFallbackRoute(user) {
  return user ? '/home' : '/login';
}

function hasUsableStoredSession(user) {
  return Boolean(user);
}

function resolveRouteRedirect(route, user) {
  const currentRoute = String(route || '/');
  const hasSession = hasUsableStoredSession(user);
  const passwordChangeRequired = Number(user?.is_first_login || 0) === 1;

  if (currentRoute === '/') {
    return hasSession && !passwordChangeRequired ? '/home' : '/login';
  }

  if (currentRoute.startsWith('/login')) {
    return hasSession && !passwordChangeRequired ? '/home' : null;
  }

  if (!hasSession) {
    return '/login';
  }

  if (passwordChangeRequired) {
    return '/login';
  }

  if (Number(user?.role_id) === 5 && currentRoute.startsWith('/dashboard')) {
    return currentRoute === '/faculty-dashboard' ? null : '/faculty-dashboard';
  }

  const requiredPermission = getPermissionFromRoute(currentRoute);
  if (requiredPermission && !canAccessModule(user, requiredPermission)) {
    const fallback = resolveFallbackRoute(user);
    return fallback !== currentRoute ? fallback : null;
  }

  return null;
}

const breadcrumbDefinitions = [
  { prefix: '/home', trail: [] },
  { prefix: '/dashboard', trail: [{ label: 'Dashboard', path: '/dashboard' }] },
  { prefix: '/faculty-dashboard', trail: [{ label: 'My Dashboard', path: '/faculty-dashboard' }] },
  { prefix: '/users', trail: [{ label: 'Users', path: '/users' }] },
  { prefix: '/attendancemgmt', trail: [{ label: 'Attendance Records', path: '/attendancemgmt' }] },
  { prefix: '/attendance-edit-requests', trail: [{ label: 'Attendance Edit Requests', path: '/attendance-edit-requests' }] },
  { prefix: '/attendance-logs', trail: [{ label: 'Attendance Adjustment Logs', path: '/attendance-logs' }] },
  { prefix: '/logs', trail: [{ label: 'Attendance Adjustment Logs', path: '/attendance-logs' }] },
  { prefix: '/attedance_audit', trail: [{ label: 'Attendance Adjustment Logs', path: '/attendance-logs' }] },
  { prefix: '/system-logs', trail: [{ label: 'Audit Trail', path: '/system-logs' }] },
  { prefix: '/notifications', trail: [{ label: 'Notifications', path: '/notifications' }] },
  { prefix: '/3d-building', trail: [{ label: '3D Campus Map', path: '/3d-building' }] },
  { prefix: '/class-schedules', trail: [{ label: 'Class Schedules', path: '/class-schedules' }] },
  { prefix: '/calendar-events', trail: [{ label: 'Holidays & Events', path: '/calendar-events' }] },
  { prefix: '/departments', trail: [{ label: 'Academic', path: '/sections' }, { label: 'Departments', path: '/departments' }] },
  { prefix: '/programs', trail: [{ label: 'Academic', path: '/sections' }, { label: 'Programs', path: '/programs' }] },
  { prefix: '/sections', trail: [{ label: 'Academic', path: '/sections' }, { label: 'Sections', path: '/sections' }] },
  { prefix: '/school_year', trail: [{ label: 'Academic', path: '/sections' }, { label: 'School Year', path: '/school_year' }] },
  { prefix: '/subjects', trail: [{ label: 'Academic', path: '/sections' }, { label: 'Subjects', path: '/subjects' }] },
  { prefix: '/subject-offerings', trail: [{ label: 'Academic', path: '/sections' }, { label: 'Subject Offerings', path: '/subject-offerings' }] },
  { prefix: '/semesters', trail: [{ label: 'Academic', path: '/sections' }, { label: 'Semesters', path: '/semesters' }] },
  { prefix: '/building', trail: [{ label: 'Facility', path: '/building' }, { label: 'Buildings', path: '/building' }] },
  { prefix: '/floors', trail: [{ label: 'Facility', path: '/building' }, { label: 'Floors', path: '/floors' }] },
  { prefix: '/rooms', trail: [{ label: 'Facility', path: '/building' }, { label: 'Rooms', path: '/rooms' }] },
  { prefix: '/settings/module-access', trail: [{ label: 'General Settings', path: '/settings/system' }, { label: 'Module Access Matrix', path: '/settings/module-access' }] },
  { prefix: '/settings/home-content', trail: [{ label: 'General Settings', path: '/settings/system' }, { label: 'Home Text Customizer', path: '/settings/home-content' }] },
  { prefix: '/settings/locked-account', trail: [{ label: 'General Settings', path: '/settings/system' }, { label: 'Locked Accounts', path: '/settings/locked-account' }] },
  { prefix: '/settings/change-password', trail: [{ label: 'General Settings', path: '/settings/system' }, { label: 'Password Reset', path: '/settings/change-password' }] },
  { prefix: '/settings/login-monitor', trail: [{ label: 'General Settings', path: '/settings/system' }, { label: 'Login Attempt Monitor', path: '/settings/login-monitor' }] },
  { prefix: '/settings/security-policy', trail: [{ label: 'General Settings', path: '/settings/system' }, { label: 'Security Policy Rules', path: '/settings/security-policy' }] },
  { prefix: '/settings/activity', trail: [{ label: 'General Settings', path: '/settings/system' }, { label: 'Settings Activity', path: '/settings/activity' }] },
  { prefix: '/settings', trail: [{ label: 'General Settings', path: '/settings/system' }] },
  { prefix: '/school', trail: [{ label: 'School Info', path: '/school' }] },
  { prefix: '/file_leave', trail: [{ label: 'File Leave', path: '/File_leave' }] },
  { prefix: '/leave_approval', trail: [{ label: 'Leave Approval', path: '/Leave_approval' }] },
  { prefix: '/substitutions', trail: [{ label: 'Substitutions', path: '/substitutions' }] },
  { prefix: '/substitute', trail: [{ label: 'Substitutions', path: '/substitutions' }] },
  { prefix: '/reports', trail: [{ label: 'Reports', path: '/reports' }] },
  { prefix: '/attendance-history', trail: [{ label: 'Faculty Portal', path: '/attendance' }, { label: 'Attendance History', path: '/attendance-history' }] },
  { prefix: '/my-attendance', trail: [{ label: 'Faculty Portal', path: '/attendance' }, { label: 'Teaching Schedule', path: '/my-attendance' }] },
  { prefix: '/my-requested-edits', trail: [{ label: 'Faculty Portal', path: '/attendance' }, { label: 'Request Edit', path: '/my-requested-edits' }] },
  { prefix: '/attendance', trail: [{ label: 'Faculty Portal', path: '/attendance' }, { label: 'Attendance', path: '/attendance' }] },
  { prefix: '/penalties', trail: [{ label: 'Penalties', path: '/penalties' }] },
  { prefix: '/data-archive', trail: [{ label: 'Administration', path: '/data-archive' }, { label: 'Data Archive', path: '/data-archive' }] },
  { prefix: '/file-upload', trail: [{ label: 'Administration', path: '/file-upload' }, { label: 'File Manager', path: '/file-upload' }] },
];

function normalizeRoutePath(routePath) {
  const raw = String(routePath || '').trim().split('?')[0].split('#')[0];
  if (!raw) return '/';
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function labelFromRouteToken(token) {
  const pretty = String(token || '').replace(/[_-]+/g, ' ').trim();
  if (!pretty) return 'Page';
  return pretty
    .split(' ')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function fallbackTrailFromRoute(routeKey) {
  const segments = String(routeKey || '').split('/').filter(Boolean);
  if (segments.length === 0) return [];
  let cumulative = '';
  return segments.map((segment) => {
    cumulative += `/${segment}`;
    return { label: labelFromRouteToken(segment), path: cumulative };
  });
}

function buildBreadcrumbItems(routePath, user) {
  const normalized = normalizeRoutePath(routePath);
  const routeKey = normalized.toLowerCase();
  if (routeKey.startsWith('/login')) return [];

  const homePath = resolveFallbackRoute(user);
  const matched = breadcrumbDefinitions.find((entry) => routeKey === entry.prefix || routeKey.startsWith(`${entry.prefix}/`));
  const trail = matched ? matched.trail : fallbackTrailFromRoute(routeKey);

  const items = [{ label: 'Home', path: homePath }];
  trail.forEach((item) => {
    if (!item || !item.label) return;
    items.push(item);
  });

  const deduped = [];
  items.forEach((item) => {
    const prev = deduped[deduped.length - 1];
    if (!prev || prev.label !== item.label || prev.path !== item.path) {
      deduped.push(item);
    }
  });
  return deduped;
}

async function promptFirstLoginPasswordChange(user) {
  if (typeof window === 'undefined' || !window.Swal || typeof window.Swal.fire !== 'function') {
    throw new Error('Password change dialog is unavailable.');
  }

  const Swal = window.Swal;
  const passwordExpired = String(user?.password_change_reason || '').toLowerCase() === 'expired';
  const safeEmail = String(user?.email || 'your account').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));

  const { value, dismiss } = await Swal.fire({
    title: '',
    html: `
      <div class="reset-password-modal first-login-required-modal">
        <div class="first-login-required-top">
          <span class="first-login-required-lock" aria-hidden="true">
            <i class="bi bi-lock"></i>
          </span>
          <h1 class="first-login-required-title">Set your new<br/>password</h1>
        </div>

        <p class="first-login-required-subtitle">
          ${passwordExpired
            ? 'Your password has reached its expiration date. Create a new password to continue.'
            : 'For security, this is your first login — you must change your password.'}
        </p>

        <div class="first-login-required-alert">
          <span class="first-login-required-alert-icon" aria-hidden="true">
            <i class="bi bi-info-circle"></i>
          </span>
          <p class="first-login-alert-text">
            Signed in as <strong>${safeEmail}</strong>.<br/>
            ${passwordExpired
              ? 'Your current and previously used passwords cannot be reused.'
              : 'The temporary password and previously used passwords cannot be reused.'}
          </p>
        </div>

        <div class="first-login-form-section">
          <label class="reset-label" for="swal-password">
            New password
          </label>
          <div class="first-login-password-control">
            <input
              id="swal-password"
              type="password"
              class="swal2-input reset-input"
              placeholder="Create a strong password"
              autocomplete="new-password"
              aria-describedby="first-login-password-help"
            />
            <button
              type="button"
              class="first-login-password-eye"
              data-target="swal-password"
              aria-label="Show new password"
            >
              <i class="bi bi-eye"></i>
            </button>
          </div>
        </div>

        <div class="first-login-form-section">
          <label class="reset-label" for="swal-confirm">
            Confirm new password
          </label>
          <div class="first-login-password-control">
            <input
              id="swal-confirm"
              type="password"
              class="swal2-input reset-input"
              placeholder="Re-enter your new password"
              autocomplete="new-password"
            />
            <button
              type="button"
              class="first-login-password-eye"
              data-target="swal-confirm"
              aria-label="Show confirmation password"
            >
              <i class="bi bi-eye"></i>
            </button>
          </div>
        </div>

        <div
          id="first-login-password-help"
          class="reset-req-card first-login-required-reqs"
          aria-live="polite"
        >
          <div class="reset-req-title">
            Password requirements
          </div>

          <div class="reset-req-list">
            <div id="pw-req-length" class="reset-req-item is-invalid">
              <span class="reset-req-mark" aria-hidden="true">✕</span>
              <span>At least 8 characters</span>
            </div>

            <div id="pw-req-letter" class="reset-req-item is-invalid">
              <span class="reset-req-mark" aria-hidden="true">✕</span>
              <span>Contains a letter (A-Z or a-z)</span>
            </div>

            <div id="pw-req-number" class="reset-req-item is-invalid">
              <span class="reset-req-mark" aria-hidden="true">✕</span>
              <span>Contains a number (0-9)</span>
            </div>

            <div id="pw-req-special" class="reset-req-item is-invalid">
              <span class="reset-req-mark" aria-hidden="true">✕</span>
              <span>Contains a special character</span>
            </div>

            <div id="pw-req-match" class="reset-req-item is-invalid">
              <span class="reset-req-mark" aria-hidden="true">✕</span>
              <span>Password confirmation matches</span>
            </div>
          </div>
        </div>
      </div>
    `,
    confirmButtonText: 'Set password & continue',
    allowOutsideClick: false,
    allowEscapeKey: false,
    showCancelButton: false,
    focusConfirm: false,
    customClass: {
      popup: 'login-reset-modal-popup first-login-required-popup',
      title: 'login-reset-modal-title',
      confirmButton: 'login-reset-modal-confirm first-login-required-confirm',
      validationMessage: 'login-reset-modal-validation'
    },
    buttonsStyling: false,
    didOpen: () => {
      const passwordInput = document.getElementById('swal-password');
      const confirmInput = document.getElementById('swal-confirm');
      const confirmButton = Swal.getConfirmButton ? Swal.getConfirmButton() : null;
      const fields = {
        length: document.getElementById('pw-req-length'),
        letter: document.getElementById('pw-req-letter'),
        number: document.getElementById('pw-req-number'),
        special: document.getElementById('pw-req-special'),
        match: document.getElementById('pw-req-match')
      };

      const applyStatus = (el, ok) => {
        if (!el) return;
        el.classList.toggle('is-valid', !!ok);
        el.classList.toggle('is-invalid', !ok);
        const mark = el.querySelector('.reset-req-mark');
        if (mark) mark.innerHTML = ok ? '&#10003;' : '&times;';
      };

      document.querySelectorAll('.first-login-password-eye').forEach((button) => {
        button.addEventListener('click', () => {
          const target = document.getElementById(button.getAttribute('data-target') || '');
          if (!target) return;
          const showing = target.type === 'text';
          target.type = showing ? 'password' : 'text';
          button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
          button.innerHTML = showing ? '<i class="bi bi-eye"></i>' : '<i class="bi bi-eye-slash"></i>';
        });
      });

      const updateStatus = () => {
        const value = passwordInput?.value || '';
        const confirmation = confirmInput?.value || '';
        const checks = {
          length: value.length >= 8,
          letter: /[A-Za-z]/.test(value),
          number: /[0-9]/.test(value),
          special: /[^A-Za-z0-9]/.test(value),
          match: value.length > 0 && confirmation.length > 0 && value === confirmation
        };

        Object.keys(checks).forEach((key) => applyStatus(fields[key], checks[key]));

        if (passwordInput) {
          const passwordReady = checks.length && checks.letter && checks.number && checks.special;
          passwordInput.classList.toggle('is-valid', passwordReady);
          passwordInput.classList.toggle('is-invalid', value.length > 0 && !passwordReady);
        }
        if (confirmInput) {
          confirmInput.classList.toggle('is-valid', checks.match);
          confirmInput.classList.toggle('is-invalid', confirmation.length > 0 && !checks.match);
        }
        if (confirmButton) {
          confirmButton.disabled = !(checks.length && checks.letter && checks.number && checks.special && checks.match);
        }
      };

      passwordInput?.addEventListener('input', updateStatus);
      confirmInput?.addEventListener('input', updateStatus);
      updateStatus();
      setTimeout(() => passwordInput?.focus?.(), 80);
    },
    preConfirm: async () => {
      const newPassword = document.getElementById('swal-password')?.value || '';
      const confirmPassword = document.getElementById('swal-confirm')?.value || '';
      const okLength = newPassword.length >= 8;
      const okLetter = /[A-Za-z]/.test(newPassword);
      const okNumber = /[0-9]/.test(newPassword);
      const okSpecial = /[^A-Za-z0-9]/.test(newPassword);

      if (!(okLength && okLetter && okNumber && okSpecial)) {
        Swal.showValidationMessage('Please complete all password requirements.');
        return null;
      }
      if (newPassword !== confirmPassword) {
        Swal.showValidationMessage('Passwords do not match.');
        return null;
      }

      try {
        return await apiPost('first-login-password', {
          new_password: newPassword,
          confirm_password: confirmPassword
        });
      } catch (error) {
        Swal.showValidationMessage(error?.body?.message || error?.message || 'Failed to change password.');
        return null;
      }
    }
  });

  return value || (dismiss ? { cancelled: true } : null);
}

function AppShell() {
  const [route, setRoute] = React.useState(window.location.hash.slice(1) || '/');
  const [hasRenderedPage, setHasRenderedPage] = React.useState(false);
  const auth = React.useContext(AuthContext) || {};
  const user = auth.user || null;
  const firstLoginPromptOpenRef = React.useRef(false);
  const handlePageReady = React.useCallback(() => setHasRenderedPage(true), []);
  const breadcrumbItems = React.useMemo(() => buildBreadcrumbItems(route, user), [route, user]);
  const redirectTarget = React.useMemo(
    () => auth.authReady ? resolveRouteRedirect(route, user) : null,
    [route, user, auth.authReady]
  );

  React.useEffect(() => {
    const onhash = () => setRoute(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onhash);
    return () => window.removeEventListener('hashchange', onhash);
  }, []);

  React.useEffect(() => {
    if (!redirectTarget || redirectTarget === route) return;
    window.location.hash = '#' + redirectTarget;
  }, [redirectTarget, route]);

  React.useEffect(() => {
    if (!user || !route.startsWith('/login')) return;
    if (Number(user?.is_first_login || 0) !== 1) return;
    if (firstLoginPromptOpenRef.current) return;

    firstLoginPromptOpenRef.current = true;
    promptFirstLoginPasswordChange(user)
      .then((result) => {
        if (!result) return;
        if (result.cancelled) {
          if (typeof auth.logout === 'function') {
            auth.logout({ notice: 'Password change is required before you can continue.' });
          } else {
            window.location.hash = '#/login';
          }
          return;
        }
        const updatedUser = {
          ...user,
          is_first_login: 0,
          password_change_reason: null,
          password_expires_at: result?.password_expires_at || null
        };
        if (typeof auth.login === 'function' && result?.session) auth.login(updatedUser, result.session);
        else if (typeof auth.updateUser === 'function') auth.updateUser(updatedUser);
      })
      .catch(async (error) => {
        try {
          if (window.Swal && typeof window.Swal.fire === 'function') {
            await window.Swal.fire({
              icon: 'error',
              title: 'Password Change Required',
              text: error?.message || 'Please reload the page and change your password.',
              confirmButtonColor: '#d33'
            });
          }
        } catch (e) {}
      })
      .finally(() => {
        firstLoginPromptOpenRef.current = false;
      });
  }, [route, user, auth]);

  if (!auth.authReady) {
    return (
      <div className="app-route-resolving" role="status" aria-live="polite" aria-label="Validating account">
        <div className="app-route-resolving-mark" aria-hidden="true"></div>
        <span className="sr-only">Validating your account with the server.</span>
      </div>
    );
  }

  if (auth.authError) {
    return (
      <main className="app-auth-validation-error" role="alert">
        <h1>Unable to validate your account</h1>
        <p>{auth.authError}</p>
        <div className="app-auth-validation-actions">
          <button type="button" onClick={() => auth.refreshAuthenticatedUser?.()}>Try Again</button>
          <button type="button" onClick={() => auth.logout?.()}>Return to Login</button>
        </div>
      </main>
    );
  }

  // Do not render the previous or unauthorized page while the hash redirect
  // is waiting for React's effect cycle. A stable transition screen prevents
  // protected content and the login form from flashing before navigation.
  if (redirectTarget && redirectTarget !== route) {
    return (
      <div
        className={hasRenderedPage ? 'app-route-navigation-status is-full-page' : 'app-route-resolving'}
        role="status"
        aria-label="Loading"
      >
        {hasRenderedPage ? 'Loading page...' : <div className="app-route-resolving-mark" aria-hidden="true"></div>}
      </div>
    );
  }

  let View = DashboardPage;
  if (route.startsWith('/attendancemgmt')) View = AttedanceManagement;
  else if (route.startsWith('/logs') || route.startsWith('/attendance-logs') || route.startsWith('/Attedance_Audit')) View = AttendanceAudit;
  else if (route.startsWith('/system-logs') || route.startsWith('/systemlogs')) View = SystemLogs;
  else if (route.startsWith('/notifications')) View = NotificationIndex;
  else if (route.startsWith('/attendance-edit-requests')) View = AttendanceEditRequestPage;
  else if (route.startsWith('/my-requested-edits')) View = RequestEditIndex;
  else if (route.startsWith('/attendance-history') || route.startsWith('/Attendance_History')) View = AttendanceHistory;
  else if (route.startsWith('/faculty-dashboard')) View = MyDashboardPage;
  else if (route.startsWith('/school_year')) View = SchoolYearIndex;
  else if (route.startsWith('/attendance')) View = AttendancePage;
  else if (route.startsWith('/dashboard')) View = Number(user?.role_id) === 5 ? MyDashboardPage : DashboardPage;
  else if (route.startsWith('/login')) View = LoginPage;
  else if (route.startsWith('/home')) View = HomeIndex;
  else if (route.startsWith('/3d-building')) View = ThreeDBuildingIndex;
  else if (route.startsWith('/building')) View = BuildingIndex;
  else if (route.startsWith('/rooms')) View = RoomIndex;
  else if (route.startsWith('/users')) View = UserIndex;
  else if (route.startsWith('/programs')) View = ProgramIndex;
  else if (route.startsWith('/departments')) View = DepartmentIndex;
  else if (route.startsWith('/floors')) View = FloorIndex;
  else if (route.startsWith('/settings')) View = GeneralSettingsIndex;
  else if (route.startsWith('/school')) View = SchoolIndex;
  else if (route.startsWith('/sections')) View = SectionIndex;
  else if (route.startsWith('/class-schedules')) View = ClassScheduleIndex;
  else if (route.startsWith('/calendar-events')) View = CalendarEventsIndex;
  else if (route.startsWith('/semesters')) View = SemesterIndex;
  else if (route.startsWith('/subject-offerings')) View = SubjectOfferingIndex;
  else if (route.startsWith('/subjects')) View = SubjectIndex;
  else if (route.startsWith('/File_leave')) View = FileLeave;
  else if (route.startsWith('/Leave_approval')) View = LeaveApproval;
  else if (route.startsWith('/penalties')) View = Penalties;
  else if (route.startsWith('/substitute') || route.startsWith('/substitutions')) View = Substitute;
  else if (route.startsWith('/my-attendance') || route.startsWith('/Teaching_Schedule')) View = MyAttendance;
  else if (route.startsWith('/reports')) View = ReportIndex;
  else if (route.startsWith('/data-archive')) View = DataArchiveIndex;
  else if (route.startsWith('/file-upload')) View = FileUploadIndex;

  return (
    <div>
      {!route.startsWith('/login') && <Navbar />}
      <div style={{ padding: route.startsWith('/login') ? 0 : 20 }}>
        {!route.startsWith('/login') && breadcrumbItems.length > 0 && (
          <nav className="app-breadcrumb" aria-label="Breadcrumb">
            <ol className="app-breadcrumb-list">
              {breadcrumbItems.map((crumb, idx) => {
                const isLast = idx === breadcrumbItems.length - 1;
                const isClickable = !!crumb.path && !isLast;
                return (
                  <li key={`${crumb.label}-${idx}`} className="app-breadcrumb-item">
                    {isClickable ? (
                      <button
                        type="button"
                        className="app-breadcrumb-link"
                        onClick={() => { window.location.hash = `#${crumb.path}`; }}
                      >
                        {crumb.label}
                      </button>
                    ) : (
                      <span className={`app-breadcrumb-current${isLast ? ' is-current' : ''}`}>{crumb.label}</span>
                    )}
                    {!isLast && <span className="app-breadcrumb-sep" aria-hidden="true">&#8250;</span>}
                  </li>
                );
              })}
            </ol>
          </nav>
        )}
        <VendorPage
          View={View}
          isInitialLoad={!hasRenderedPage}
          onPageReady={handlePageReady}
        />
      </div>
    </div>
  );
}

function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  );
}

export default App;

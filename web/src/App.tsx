import React from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { api, ROLE_META, type User } from './api';
import { t } from './i18n';
import { Landing } from './pages/Landing';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { InspectionsList } from './pages/InspectionsList';
import { NewInspection } from './pages/NewInspection';
import { InspectionDetail } from './pages/InspectionDetail';
import { Workbench } from './pages/Workbench';
import { ReportView } from './pages/ReportView';
import { Repository } from './pages/Repository';
import { RuleLibrary } from './pages/RuleLibrary';
import { AuditLog } from './pages/AuditLog';
import { AdminUsers } from './pages/AdminUsers';
import { Trash } from './pages/Trash';
import { Analytics } from './pages/Analytics';
import { OfflineDrafts } from './pages/OfflineDrafts';
import { syncDrafts, pendingCount } from './offline';

// `permissions` is the server's own role→permission list for the signed-in user
// (GET /auth/me). Components ask `can('inspection.delete')` rather than testing role
// names, so the UI can never drift from the matrix the API actually enforces.
export const AuthContext = React.createContext<{
  user: User | null; demoProviders: boolean; permissions: string[];
  can: (perm: string) => boolean; refresh: () => void;
}>({
  user: null, demoProviders: false, permissions: [], can: () => false, refresh: () => {},
});

export function usePerm() {
  return React.useContext(AuthContext).can;
}

export function App() {
  const [user, setUser] = React.useState<User | null | undefined>(undefined);
  const [demoProviders, setDemo] = React.useState(false);
  const [mockComponents, setMockComponents] = React.useState<string[]>([]);
  const [permissions, setPermissions] = React.useState<string[]>([]);
  const [online, setOnline] = React.useState(navigator.onLine);

  const refresh = React.useCallback(() => {
    api.get<{ user: User; demoProviders: boolean; mockComponents?: string[]; permissions?: string[] }>('/auth/me')
      .then((r) => {
        setUser(r.user); setDemo(r.demoProviders);
        setMockComponents(r.mockComponents ?? []); setPermissions(r.permissions ?? []);
      })
      .catch(() => { setUser(null); setPermissions([]); });
  }, []);
  const can = React.useCallback((perm: string) => permissions.includes(perm), [permissions]);
  React.useEffect(refresh, [refresh]);
  React.useEffect(() => {
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  if (user === undefined) return <div className="content muted">Loading…</div>;

  return (
    <AuthContext.Provider value={{ user: user ?? null, demoProviders, permissions, can, refresh }}>
      {!online && <div className="offline-banner" role="status">⚠ Offline — drafts stay on this device until connectivity returns. Do not close the browser with unsaved uploads.</div>}
      <Routes>
        <Route path="/" element={user ? <Navigate to="/app" replace /> : <Landing />} />
        <Route path="/login" element={user ? <Navigate to="/app" replace /> : <Login />} />
        <Route path="/app/*" element={user
          ? <Shell user={user} demo={demoProviders} mockComponents={mockComponents} />
          : <Navigate to="/login" replace />} />
      </Routes>
    </AuthContext.Provider>
  );
}

function Shell({ user, demo, mockComponents }: { user: User; demo: boolean; mockComponents: string[] }) {
  const nav = useNavigate();
  const { refresh, can } = React.useContext(AuthContext);
  const logout = async () => { await api.post('/auth/logout'); refresh(); nav('/'); };
  const [pending, setPending] = React.useState(0);

  // Auto-sync encrypted offline drafts when connectivity returns (MOB-01/02).
  React.useEffect(() => {
    const update = () => pendingCount().then(setPending);
    const onOnline = () => { syncDrafts().finally(update); };
    update();
    if (navigator.onLine) onOnline();
    window.addEventListener('online', onOnline);
    const t = setInterval(update, 15000);
    return () => { window.removeEventListener('online', onOnline); clearInterval(t); };
  }, []);
  return (
    <div className="app-shell">
      <nav className="sidenav" aria-label="Main navigation">
        <div className="brand">{t('app.name')}<small>{t('app.tagline')}</small></div>
        <div className="who-badge" title={ROLE_META[user.role]?.hint}>
          {user.name}<small>{ROLE_META[user.role]?.label ?? user.role}</small>
        </div>
        <NavLink to="/app" end>{t('nav.dashboard')}</NavLink>
        {can('inspection.read') && <NavLink to="/app/inspections">{t('nav.inspections')}</NavLink>}
        {can('inspection.create') && <NavLink to="/app/inspections/new">{t('nav.newInspection')}</NavLink>}
        {can('evidence.upload') && (
          <NavLink to="/app/offline">Offline drafts{pending > 0 ? ` (${pending})` : ''}</NavLink>
        )}
        {can('search.read') && <NavLink to="/app/repository">{t('nav.repository')}</NavLink>}
        {can('analytics.view') && <NavLink to="/app/analytics">{t('nav.analytics')}</NavLink>}
        <div className="nav-section">Governance</div>
        {can('rule.read') && <NavLink to="/app/rules">{t('nav.rules')}</NavLink>}
        {can('audit.read') && <NavLink to="/app/audit">{t('nav.audit')}</NavLink>}
        {can('admin.users') && <NavLink to="/app/admin/users">{t('nav.users')}</NavLink>}
        {can('inspection.delete') && <NavLink to="/app/admin/trash">{t('nav.trash')}</NavLink>}
        <div className="spacer" />
        <a href="#" onClick={(e) => { e.preventDefault(); logout(); }}>{t('nav.logout')}</a>
      </nav>
      <div className="main">
        {demo && (
          <div className="demo-banner" role="note">
            ◌ DEMO PROVIDERS ACTIVE for {mockComponents.length ? mockComponents.join(', ') : 'some components'} —
            these outputs are deterministic mocks, not production AI. OCR is real (self-hosted tesseract, English + Hindi).
          </div>
        )}
        <Routes>
          <Route index element={<Dashboard />} />
          <Route path="inspections" element={<InspectionsList />} />
          <Route path="inspections/new" element={<NewInspection />} />
          <Route path="inspections/:id" element={<InspectionDetail />} />
          <Route path="inspections/:id/workbench" element={<Workbench />} />
          <Route path="inspections/:id/report" element={<ReportView />} />
          <Route path="offline" element={<OfflineDrafts />} />
          <Route path="repository" element={<Repository />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="rules" element={<RuleLibrary />} />
          <Route path="audit" element={<AuditLog />} />
          <Route path="admin/users" element={<AdminUsers />} />
          <Route path="admin/trash" element={<Trash />} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </div>
    </div>
  );
}

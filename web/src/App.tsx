import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { api, type User } from './api';
import { Landing } from './pages/Landing';
import { Login } from './pages/Login';
import { Signup } from './pages/Signup';
import { ScanShell } from './scan/ScanShell';
import { ReviewShell } from './review/ReviewShell';

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
        {/* Signup is the front door: a new officer registers, then scans. The
            marketing landing page stays reachable at /about for anyone who wants
            the platform overview first. */}
        <Route path="/" element={user ? <Navigate to="/app" replace /> : <Signup />} />
        <Route path="/about" element={user ? <Navigate to="/app" replace /> : <Landing />} />
        <Route path="/login" element={user ? <Navigate to="/app" replace /> : <Login />} />
        {/* Two applications, one per side of the segregation of duties: a field
            officer captures, a reviewer judges. Neither shell offers the other's
            controls, because neither role holds the other's permissions. */}
        <Route path="/app/*" element={!user
          ? <Navigate to="/login" replace />
          : user.role === 'user'
            ? <ScanShell user={user} />
            : <ReviewShell user={user} demo={demoProviders} mockComponents={mockComponents} />} />
      </Routes>
    </AuthContext.Provider>
  );
}

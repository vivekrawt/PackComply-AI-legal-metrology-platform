import React from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, type User } from '../api';
import { AuthContext } from '../App';
import { ScanHome } from './ScanHome';
import { ScanCapture } from './ScanCapture';
import { ScanResult } from './ScanResult';
import { ScanHistory } from './ScanHistory';

// The field officer's entire application. Deliberately four screens — scan,
// result, history, report — with none of the reviewer/administrator surface:
// rule authoring, audit log, analytics, dispositions and the recycle bin are
// authority a field officer does not hold, so showing them would only be noise
// they cannot act on.

export function ScanShell({ user }: { user: User }) {
  const nav = useNavigate();
  const { refresh } = React.useContext(AuthContext);
  const logout = async () => { await api.post('/auth/logout'); refresh(); nav('/'); };

  return (
    <div className="field-app">
      <header className="field-top">
        <NavLink to="/app" className="field-brand" end>
          <span className="field-logo" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M12 3l7 2.5v5.2c0 4.5-3 8.2-7 9.8-4-1.6-7-5.3-7-9.8V5.5L12 3z" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M9 11.6l2.1 2.1L15.3 9.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          PackComply
        </NavLink>
        <nav className="field-nav" aria-label="Main">
          <NavLink to="/app" end>Scan</NavLink>
          <NavLink to="/app/history">History</NavLink>
        </nav>
        <div className="field-who">
          <span title={user.email}>{user.name}</span>
          <button className="quiet" onClick={logout}>Sign out</button>
        </div>
      </header>

      <main className="field-main">
        <Routes>
          <Route index element={<ScanHome />} />
          <Route path="scan/new" element={<ScanCapture />} />
          <Route path="scan/:id" element={<ScanResult />} />
          <Route path="history" element={<ScanHistory />} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </main>
    </div>
  );
}

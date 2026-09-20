import React from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, ROLE_META, type User } from '../api';
import { AuthContext } from '../App';
import { WhoBadge } from '../components/common';
import { ShieldMark } from '../components/icons';
import { ScanHome } from './ScanHome';
import { ScanCapture } from './ScanCapture';
import { ScanResult } from './ScanResult';
import { ScanHistory } from './ScanHistory';

// The field officer's entire application. Deliberately four screens — scan,
// result, history, report — with none of the reviewer/administrator surface:
// rule authoring, audit log, analytics, dispositions and the recycle bin are
// authority a field officer does not hold, so showing them would only be noise
// they cannot act on.
//
// Two tabs, because there are two things an officer does here: scan the next
// package, or look up one they already scanned. A rail would imply more.

export function ScanShell({ user }: { user: User }) {
  const nav = useNavigate();
  const { refresh } = React.useContext(AuthContext);
  const logout = async () => { await api.post('/auth/logout'); refresh(); nav('/'); };

  return (
    <div className="field-app">
      <header className="pc-topbar">
        <NavLink to="/app" className="pc-topbar-brand" end>
          <span className="pc-mark"><ShieldMark /></span>
          <span className="pc-wordmark">PackComply</span>
        </NavLink>

        <nav className="pc-tabs" aria-label="Main">
          <NavLink to="/app" end>Scan</NavLink>
          <NavLink to="/app/history">History</NavLink>
        </nav>

        <div className="pc-topbar-end">
          <WhoBadge name={user.name} role={ROLE_META[user.role]?.short ?? 'Field officer'} email={user.email} />
          <button className="pc-signout" onClick={logout}>Sign out</button>
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

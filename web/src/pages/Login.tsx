import React from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { AuthContext } from '../App';
import { t } from '../i18n';
import { ErrorText } from '../components/common';

// Demo quick sign-in: one click per seeded role account. These accounts exist
// only in the seeded demo data; a real deployment uses SSO/local accounts and
// this panel would be removed.
const DEMO_PASSWORD = 'PackComply#2026';
const DEMO_ACCOUNTS = [
  {
    label: 'User — field officer', email: 'user@demo.gov.example',
    hint: 'Uses the product: open a case, capture the package, run the compliance check, correct declarations.',
  },
  {
    label: 'Admin — reviewer', email: 'admin@demo.gov.example',
    hint: 'Reviews the work only: dispose findings, approve overrides, finalize reports, issue notices, read the audit log.',
  },
  {
    label: 'Super administrator', email: 'superadmin@demo.gov.example',
    hint: 'Full write and delete: rule publication, user and configuration administration, record deletion.',
  },
];

export function Login() {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [showForm, setShowForm] = React.useState(false);
  const { refresh } = React.useContext(AuthContext);
  const nav = useNavigate();

  const doLogin = async (loginEmail: string, loginPassword: string, busyKey: string) => {
    setBusy(busyKey); setError(null);
    try {
      await api.post('/auth/login', { email: loginEmail, password: loginPassword });
      refresh();
      nav('/app');
    } catch (err) { setError(err); } finally { setBusy(null); }
  };

  return (
    <div className="landing" style={{ display: 'grid', placeItems: 'center', padding: '24px 0' }}>
      <div className="card" style={{ width: 440, maxWidth: '94vw' }}>
        <h2>{t('login.title')}</h2>
        <p className="muted" style={{ marginTop: 0 }}>Demo environment — pick a role to sign in with one click:</p>

        <div style={{ display: 'grid', gap: 8 }}>
          {DEMO_ACCOUNTS.map((a) => (
            <button key={a.email} className="secondary" disabled={busy !== null}
              style={{ textAlign: 'left', display: 'block', width: '100%' }}
              onClick={() => doLogin(a.email, DEMO_PASSWORD, a.email)}>
              {busy === a.email ? '⟳ Signing in…' : `Sign in as ${a.label}`}
              <span className="muted" style={{ display: 'block', fontWeight: 400, fontSize: '0.78rem' }}>{a.hint}</span>
            </button>
          ))}
        </div>

        <ErrorText error={error} />

        <p style={{ marginTop: 14 }}>
          <button className="quiet" onClick={() => setShowForm(!showForm)} aria-expanded={showForm}>
            {showForm ? 'Hide' : 'Use'} e-mail &amp; password instead
          </button>
        </p>
        {showForm && (
          <form onSubmit={(e) => { e.preventDefault(); doLogin(email, password, 'form'); }}>
            <label className="field">{t('login.email')}
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">{t('login.password')}
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button className="primary" disabled={busy !== null} style={{ width: '100%', marginTop: 8 }}>{t('login.submit')}</button>
          </form>
        )}
      </div>
    </div>
  );
}

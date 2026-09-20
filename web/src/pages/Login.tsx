import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { AuthContext } from '../App';
import { t } from '../i18n';
import { ErrorText } from '../components/common';
import { ShieldMark } from '../components/icons';

// Demo quick sign-in: one click per seeded role account. These accounts exist
// only in the seeded demo data; a real deployment uses SSO/local accounts and
// this panel would be removed.
//
// Each button says what that role can actually do, because the three roles are the
// product's segregation of duties and picking one is picking which application you
// are about to see.
const DEMO_PASSWORD = 'PackComply#2026';
const DEMO_ACCOUNTS = [
  {
    label: 'Field officer', email: 'user@demo.gov.example',
    hint: 'Captures packages, runs the compliance check, sends scans for approval.',
  },
  {
    label: 'Reviewer (admin)', email: 'admin@demo.gov.example',
    hint: 'Signs off their own team’s work: accept, reject, send back or refer upward.',
  },
  {
    label: 'Super administrator', email: 'superadmin@demo.gov.example',
    hint: 'Runs the organization: teams, people, rules, deleted records and the audit trail.',
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
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-logo" aria-hidden="true"><ShieldMark size={24} /></span>
          <div>
            <b>PackComply</b>
            <small>Legal Metrology compliance checks</small>
          </div>
        </div>

        <h1>{t('login.title')}</h1>
        <p className="auth-sub">Demo environment — choose the role you want to sign in as.</p>

        <div className="role-picker">
          {DEMO_ACCOUNTS.map((a) => (
            <button key={a.email} className="role-btn" disabled={busy !== null}
              onClick={() => doLogin(a.email, DEMO_PASSWORD, a.email)}>
              {busy === a.email ? 'Signing in…' : a.label}
              <small>{a.hint}</small>
            </button>
          ))}
        </div>

        <ErrorText error={error} />

        <div className="auth-divider" style={{ margin: '20px 0 16px' }}>or</div>

        {!showForm ? (
          <button className="quiet wide" onClick={() => setShowForm(true)} aria-expanded={false}>
            Use e-mail &amp; password
          </button>
        ) : (
          <form onSubmit={(e) => { e.preventDefault(); doLogin(email, password, 'form'); }}>
            <label className="field">{t('login.email')}
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">{t('login.password')}
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <button className="primary big" disabled={busy !== null}>{t('login.submit')}</button>
          </form>
        )}

        <p className="auth-alt">
          No account yet? <Link to="/">Create one</Link>
        </p>
      </div>
    </div>
  );
}

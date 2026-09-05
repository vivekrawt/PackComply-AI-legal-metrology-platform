import React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { AuthContext } from '../App';
import { ErrorText } from '../components/common';

// Entry point of the product. A new account is always a field officer; review and
// administrative authority is granted by an existing administrator, never claimed
// at registration.

const MIN_PASSWORD = 10;

// One-click account for the testing phase. Fixed credentials on purpose: the
// second press signs back into the same account rather than colliding, so a
// tester keeps the scan history they built up. It goes through the same
// /auth/signup validation and the same 'user' role as a real registration —
// there is no bypass path into the app, only a pre-filled form.
const TEST_ACCOUNT = {
  name: 'Test Field Officer',
  email: 'tester@packcomply.test',
  password: 'PackComplyTest#1',
};

export function Signup() {
  const [f, setF] = React.useState({ name: '', email: '', password: '', confirm: '' });
  const [error, setError] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const { refresh } = React.useContext(AuthContext);
  const nav = useNavigate();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const mismatch = f.confirm.length > 0 && f.password !== f.confirm;
  const tooShort = f.password.length > 0 && f.password.length < MIN_PASSWORD;
  const canSubmit = f.name.trim().length >= 2 && f.email.includes('@')
    && f.password.length >= MIN_PASSWORD && f.password === f.confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      await api.post('/auth/signup', {
        name: f.name.trim(), email: f.email.trim(), password: f.password,
      });
      refresh();
      nav('/app');
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  const quickStart = async () => {
    setBusy(true); setError(null);
    try {
      try {
        await api.post('/auth/signup', TEST_ACCOUNT);
      } catch (err) {
        // 409 means a previous test run already registered it — sign in instead.
        if (!(err instanceof ApiError && err.status === 409)) throw err;
        await api.post('/auth/login', { email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password });
      }
      refresh();
      nav('/app');
    } catch (err) { setError(err); } finally { setBusy(false); }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-logo" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <path d="M12 3l7 2.5v5.2c0 4.5-3 8.2-7 9.8-4-1.6-7-5.3-7-9.8V5.5L12 3z" stroke="#fff" strokeWidth="1.8" strokeLinejoin="round" />
              <path d="M9 11.6l2.1 2.1L15.3 9.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
          <div>
            <b>PackComply</b>
            <small>Legal Metrology compliance checks</small>
          </div>
        </div>

        <h1>Create your account</h1>
        <p className="auth-sub">
          Scan a packaged product, and get a compliance assessment against the
          Legal Metrology (Packaged Commodities) Rules, 2011.
        </p>

        <div className="quick-signup">
          <h2>Testing phase</h2>
          <p>Skip the form and go straight to scanning with a shared test account.</p>
          <button className="secondary wide" onClick={quickStart} disabled={busy}>
            {busy ? 'Please wait…' : '⚡ One-click test account'}
          </button>
          <p style={{ margin: '8px 0 0' }}>
            Signs in as <code>{TEST_ACCOUNT.email}</code> · password <code>{TEST_ACCOUNT.password}</code>
          </p>
        </div>

        <div className="auth-divider">or register properly</div>

        <form onSubmit={submit}>
          <label className="field">Full name
            <input value={f.name} onChange={set('name')} autoComplete="name" required placeholder="Your name" />
          </label>
          <label className="field">Work e-mail
            <input type="email" value={f.email} onChange={set('email')} autoComplete="username" required placeholder="you@example.gov.in" />
          </label>
          <label className="field">Password
            <input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" required />
            <span className={`hint ${tooShort ? 'bad' : ''}`}>
              {tooShort ? `At least ${MIN_PASSWORD} characters — ${MIN_PASSWORD - f.password.length} to go.` : `At least ${MIN_PASSWORD} characters.`}
            </span>
          </label>
          <label className="field">Confirm password
            <input type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" required aria-invalid={mismatch} />
            {mismatch && <span className="hint bad">Passwords do not match.</span>}
          </label>

          <ErrorText error={error} />

          <button className="primary big" disabled={busy || !canSubmit}>
            {busy ? 'Creating account…' : 'Create account'}
          </button>
        </form>

        <p className="auth-alt">
          Already registered? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}

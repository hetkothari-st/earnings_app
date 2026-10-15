import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { login } from '../api';
import '../login.css';

/** US session hours (ET) drawn as a band: pre-market, regular session, after hours. */
const SESSIONS = [
  { cls: 'pre', label: 'Pre-market', hours: 5.5 },
  { cls: 'open', label: 'Market open', hours: 6.5 },
  { cls: 'after', label: 'After hours', hours: 4 },
] as const;
const TICKS = ['04:00', '09:30', '16:00', '20:00'];

export function LoginPage({ onSignedIn }: { onSignedIn: () => void }) {
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const errorId = `${uid}-error`;
  const pwId = `${uid}-password`;
  const pwRef = useRef<HTMLInputElement>(null);

  // After a failed attempt the fields are enabled again; put the cursor back in the password field.
  useEffect(() => { if (error && !pending) pwRef.current?.focus(); }, [error, pending]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (pending) return;
    if (!id.trim() || !password) {
      setError('Enter your user ID and password.');
      return;
    }
    setPending(true);
    setError(null);
    const failure = await login(id.trim(), password);
    if (failure == null) {
      onSignedIn();
      return;
    }
    setPending(false);
    setPassword('');
    setError(failure);
  }

  return (
    <div className="login">
      <section className="login-brand" aria-labelledby={`${uid}-title`}>
        <p className="login-kicker">Earnings calendar · US listings</p>
        <h1 id={`${uid}-title`} className="login-wordmark">
          <span>US</span>
          <span>earnings</span>
        </h1>
        <div className="login-band" aria-hidden="true">
          <div className="login-band-track">
            {SESSIONS.map((s, i) => (
              <span key={s.cls} className={`login-seg login-seg-${s.cls}`} style={{ flexGrow: s.hours, animationDelay: `${120 + i * 260}ms` }}>
                {s.label}
              </span>
            ))}
          </div>
          <div className="login-ticks">
            {TICKS.map((t) => <span key={t}>{t}</span>)}
            <span className="login-tz">ET</span>
          </div>
        </div>
        <ul className="login-legend">
          <li><span className="dot dot-dawn" aria-hidden="true" />Reports before the open</li>
          <li><span className="dot dot-dusk" aria-hidden="true" />Reports after the close</li>
        </ul>
      </section>

      <section className="login-panel">
        <form className="login-form" onSubmit={submit} noValidate aria-describedby={error ? errorId : undefined}>
          <h2 className="login-title">Sign in</h2>
          <p className="login-note">Use the user ID and password you were given.</p>

          <label className="login-field" htmlFor={`${uid}-id`}>
            <span>User ID</span>
          </label>
          <input
            id={`${uid}-id`} className="login-input" name="username" autoComplete="username" autoCapitalize="characters"
            autoCorrect="off" spellCheck={false} autoFocus value={id} disabled={pending}
            aria-invalid={error ? true : undefined}
            onChange={(e) => { setId(e.target.value); setError(null); }}
          />

          <label className="login-field" htmlFor={pwId}>
            <span>Password</span>
          </label>
          <div className="login-password">
            <input
              id={pwId} ref={pwRef} className="login-input" name="password" type={show ? 'text' : 'password'} autoComplete="current-password"
              value={password} disabled={pending} aria-invalid={error ? true : undefined}
              onChange={(e) => { setPassword(e.target.value); setError(null); }}
            />
            <button
              type="button" className="login-reveal" aria-controls={pwId} aria-pressed={show}
              aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((v) => !v)}
            >
              {show ? 'Hide' : 'Show'}
            </button>
          </div>

          <p className="login-error" id={errorId} role={error ? 'alert' : undefined} aria-live="polite">{error}</p>

          <button type="submit" className="login-submit" disabled={pending} aria-busy={pending}>
            {pending && <span className="login-spinner" aria-hidden="true" />}
            {pending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </div>
  );
}

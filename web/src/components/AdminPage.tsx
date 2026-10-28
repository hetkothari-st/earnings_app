import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import {
  type AdminUser, bulkIds, bulkPreview, createUser, createUsersBulk, deleteUser, fetchKiteStatus, kiteBrowserLoginUrl, kiteLoginNow, listUsers,
  fetchEuropeAdmin, fetchHkAdmin, fetchJpAdmin, MAX_BULK, normalizeId, passwordProblem, updateUser, validId,
} from '../adminApi';
import type { EuropeAdminDto, HkAdminDto, JpAdminDto, KiteStatusDto } from '../api';
import { useAccount } from '../lib/account';
import '../admin.css';

const ID_RULE = 'User ID must be 1-64 letters, digits, dot, dash, underscore or @';

type Msg = { kind: 'ok' | 'error'; text: string } | null;

function Message({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return msg.kind === 'ok'
    ? <p role="status" className="admin-msg admin-msg-ok">{msg.text}</p>
    : <p role="alert" className="admin-msg admin-msg-error">{msg.text}</p>;
}

function when(iso: string | null): ReactNode {
  if (!iso) return <span className="admin-muted">Never</span>;
  const d = new Date(iso);
  const text = d.toLocaleString('en-US', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  return <time dateTime={iso}>{text}</time>;
}

/** A password input with a show/hide toggle, styled like the sign-in page. */
function PasswordField({ label, value, onChange, autoComplete = 'new-password' }: {
  label: string; value: string; onChange: (v: string) => void; autoComplete?: string;
}) {
  const id = useId();
  const [show, setShow] = useState(false);
  return (
    <div className="admin-field">
      <label htmlFor={id}>{label}</label>
      <div className="admin-password">
        <input
          id={id} type={show ? 'text' : 'password'} value={value} autoComplete={autoComplete} spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button" className="admin-reveal" aria-controls={id} aria-pressed={show}
          aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((v) => !v)}
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}

function TextField({ label, value, onChange, ...rest }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; min?: number; max?: number; inputMode?: 'numeric';
  placeholder?: string;
}) {
  const id = useId();
  return (
    <div className="admin-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} autoComplete="off" autoCapitalize="characters" spellCheck={false} onChange={(e) => onChange(e.target.value)} {...rest} />
    </div>
  );
}

function AddUserForm({ onAdded }: { onAdded: () => void }) {
  const titleId = useId();
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!validId(id)) return setMsg({ kind: 'error', text: ID_RULE });
    const problem = passwordProblem(password);
    if (problem) return setMsg({ kind: 'error', text: problem });
    setBusy(true);
    const res = await createUser({ id: id.trim(), password, isAdmin: admin });
    setBusy(false);
    if (!res.ok) return setMsg({ kind: 'error', text: res.error });
    setMsg({ kind: 'ok', text: `Added ${res.data.id}` });
    setId('');
    setPassword('');
    setAdmin(false);
    onAdded();
  }

  return (
    <form className="admin-card" aria-labelledby={titleId} onSubmit={submit} noValidate>
      <h2 id={titleId}>Add user</h2>
      <p className="admin-note">IDs are not case-sensitive. Email addresses work too.</p>
      <TextField label="User ID" value={id} onChange={(v) => { setId(v); setMsg(null); }} />
      <PasswordField label="Password" value={password} onChange={(v) => { setPassword(v); setMsg(null); }} />
      <label className="admin-check">
        <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
        <span>Make admin</span>
      </label>
      <Message msg={msg} />
      <button type="submit" className="admin-primary" disabled={busy} aria-busy={busy}>Add user</button>
    </form>
  );
}

function AddManyForm({ onAdded }: { onAdded: () => void }) {
  const titleId = useId();
  const [prefix, setPrefix] = useState('');
  const [start, setStart] = useState('1');
  const [count, setCount] = useState('10');
  const [suffix, setSuffix] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const startN = start.trim() === '' ? NaN : Number(start);
  const countN = count.trim() === '' ? NaN : Number(count);
  const preview = bulkPreview(prefix, startN, countN, suffix);
  const edit = (set: (v: string) => void) => (v: string) => { set(v); setMsg(null); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!preview) return setMsg({ kind: 'error', text: `Check the numbers: count must be 1 to ${MAX_BULK} and every ID must be valid` });
    const problem = passwordProblem(password);
    if (problem) return setMsg({ kind: 'error', text: problem });
    setBusy(true);
    const res = await createUsersBulk({ prefix, start: startN, count: countN, suffix, password });
    setBusy(false);
    if (!res.ok) return setMsg({ kind: 'error', text: res.error });
    const ids = bulkIds(prefix, startN, countN, suffix);
    const range = ids.length === 1 ? ids[0] : `${ids[0]} … ${ids[ids.length - 1]}`;
    setMsg({ kind: 'ok', text: `Added ${ids.length} user${ids.length === 1 ? '' : 's'}: ${range}` });
    setPassword('');
    onAdded();
  }

  return (
    <form className="admin-card" aria-labelledby={titleId} onSubmit={submit} noValidate>
      <h2 id={titleId}>Add many</h2>
      <p className="admin-note">Numbered IDs that share one password. Nothing is created if any ID is taken.</p>
      <div className="admin-grid">
        <TextField label="Prefix" value={prefix} onChange={edit(setPrefix)} placeholder="none" />
        <TextField label="Start number" value={start} onChange={edit(setStart)} type="number" min={0} inputMode="numeric" />
        <TextField label="Count" value={count} onChange={edit(setCount)} type="number" min={1} max={MAX_BULK} inputMode="numeric" />
        <TextField label="Suffix" value={suffix} onChange={edit(setSuffix)} placeholder="none" />
      </div>
      <p className="admin-preview">
        <span className="admin-muted">Creates </span>
        <output aria-live="polite">{preview ?? `Count must be 1 to ${MAX_BULK} and IDs must be valid`}</output>
      </p>
      <PasswordField label="Shared password" value={password} onChange={edit(setPassword)} />
      <Message msg={msg} />
      <button type="submit" className="admin-primary" disabled={busy} aria-busy={busy}>
        {preview ? `Add ${countN} user${countN === 1 ? '' : 's'}` : 'Add users'}
      </button>
    </form>
  );
}

function EditUser({ user, self, onDone, onCancel }: {
  user: AdminUser; self: boolean; onDone: (newId: string) => void; onCancel: () => void;
}) {
  const [newId, setNewId] = useState(user.id);
  const [password, setPassword] = useState('');
  const [admin, setAdmin] = useState(user.isAdmin);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const change: { password?: string; newId?: string; isAdmin?: boolean } = {};
    if (password) {
      const problem = passwordProblem(password);
      if (problem) return setMsg({ kind: 'error', text: problem });
      change.password = password;
    }
    if (normalizeId(newId) !== user.id) {
      if (!validId(newId)) return setMsg({ kind: 'error', text: ID_RULE });
      change.newId = newId.trim();
    }
    if (admin !== user.isAdmin) change.isAdmin = admin;
    if (Object.keys(change).length === 0) return setMsg({ kind: 'error', text: 'Nothing to save' });
    setBusy(true);
    const res = await updateUser(user.id, change);
    setBusy(false);
    if (!res.ok) return setMsg({ kind: 'error', text: res.error });
    onDone(res.data.id);
  }

  return (
    <form className="admin-edit" aria-label={`Edit ${user.id}`} onSubmit={submit} noValidate>
      <div className="admin-grid">
        <TextField label="User ID" value={newId} onChange={(v) => { setNewId(v); setMsg(null); }} />
        <PasswordField label="New password" value={password} onChange={(v) => { setPassword(v); setMsg(null); }} />
      </div>
      <label className="admin-check">
        <input type="checkbox" checked={admin} onChange={(e) => { setAdmin(e.target.checked); setMsg(null); }} />
        <span>Admin</span>
      </label>
      <p className="admin-note">
        Leave the password empty to keep it. A new password or ID signs {self ? 'you' : 'them'} out everywhere.
      </p>
      <Message msg={msg} />
      <div className="admin-actions">
        <button type="submit" className="admin-primary" disabled={busy} aria-busy={busy}>Save</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function UserRows({ user, self, editing, onEdit, onSaved, onDeleted, onCancel }: {
  user: AdminUser; self: boolean; editing: boolean;
  onEdit: () => void; onSaved: (newId: string) => void; onDeleted: () => void; onCancel: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setBusy(true);
    const res = await deleteUser(user.id);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    onDeleted();
  }

  return (
    <>
      <tr className={editing ? 'admin-row is-editing' : 'admin-row'}>
        <th scope="row" className="admin-id">{user.id}</th>
        <td data-label="Role">
          <span className={user.isAdmin ? 'admin-role is-admin' : 'admin-role'}>{user.isAdmin ? 'Admin' : 'User'}</span>
          {self && <span className="admin-you">you</span>}
        </td>
        <td data-label="Created">{when(user.createdAt)}</td>
        <td data-label="Last sign-in">{when(user.lastLoginAt)}</td>
        <td className="admin-row-actions">
          {confirming ? (
            <div className="admin-confirm">
              <span>Delete {user.id}? Their notes go too.</span>
              <div className="admin-actions">
                <button type="button" className="admin-danger" disabled={busy} onClick={remove}>Delete {user.id}</button>
                <button type="button" onClick={() => { setConfirming(false); setError(null); }}>Cancel</button>
              </div>
              {error && <p role="alert" className="admin-msg admin-msg-error">{error}</p>}
            </div>
          ) : (
            <div className="admin-actions">
              <button type="button" aria-expanded={editing} onClick={editing ? onCancel : onEdit}>Edit</button>
              {!self && <button type="button" onClick={() => setConfirming(true)}>Delete</button>}
            </div>
          )}
        </td>
      </tr>
      {editing && (
        <tr className="admin-edit-row">
          <td colSpan={5}>
            <EditUser user={user} self={self} onDone={onSaved} onCancel={onCancel} />
          </td>
        </tr>
      )}
    </>
  );
}

/** Zerodha (Kite) connection for India prices and option quotes. */
function ZerodhaPanel() {
  const [status, setStatus] = useState<KiteStatusDto | null>(null);
  // Back from Zerodha's login page (the backup login): say how it went once, then tidy the address bar.
  const [msg, setMsg] = useState<Msg>(() => {
    const k = new URLSearchParams(window.location.search).get('kite');
    return k === 'ok' ? { kind: 'ok', text: 'Connected to Zerodha' } : k === 'error' ? { kind: 'error', text: 'Zerodha page login did not complete' } : null;
  });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has('kite')) window.history.replaceState(null, '', '/admin');
    void fetchKiteStatus().then((r) => (r.ok ? setStatus(r.data) : setMsg({ kind: 'error', text: r.error })));
  }, []);
  const login = async () => {
    setBusy(true);
    setMsg(null);
    const r = await kiteLoginNow();
    setBusy(false);
    if (!r.ok) return setMsg({ kind: 'error', text: r.error });
    setStatus(r.data);
    setMsg(r.data.connected ? { kind: 'ok', text: 'Connected to Zerodha' } : { kind: 'error', text: r.data.lastError ?? 'Login failed' });
  };
  const pageLogin = async () => {
    setBusy(true);
    setMsg(null);
    const r = await kiteBrowserLoginUrl();
    if (!r.ok) { setBusy(false); return setMsg({ kind: 'error', text: r.error }); }
    window.location.assign(r.data);
  };
  return (
    <section className="admin-card" aria-label="Zerodha">
      <h2>Zerodha (India)</h2>
      <Message msg={msg} />
      {!status ? <p className="admin-muted">Loading…</p> : !status.configured ? (
        <p className="admin-muted">Not configured. Set KITE_API_KEY, KITE_API_SECRET, KITE_USER_ID, KITE_PASSWORD and KITE_TOTP_SECRET on the server.</p>
      ) : (
        <>
          <p>{status.connected ? 'Connected' : 'Not connected'} · last login {when(status.lastLoginAt)}</p>
          {status.lastError && <p className="admin-msg admin-msg-error">Last error ({when(status.lastErrorAt)}): {status.lastError}</p>}
          <button type="button" onClick={() => void login()} disabled={busy}>{busy ? 'Logging in…' : 'Log in now'}</button>
          {' '}
          <button type="button" onClick={() => void pageLogin()} disabled={busy}>Log in on the Zerodha page</button>
          <p className="admin-muted">
            Use the Zerodha page when "Log in now" fails (Zerodha sometimes asks for a CAPTCHA). Your Kite app's
            redirect URL must be <code>{window.location.origin}/api/admin/kite/callback</code>.
          </p>
        </>
      )}
    </section>
  );
}

/** Japan coverage, SEC and EDINET settings. Read-only. */
function JapanPanel() {
  const [jp, setJp] = useState<JpAdminDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetchJpAdmin().then((r) => (r.ok ? setJp(r.data) : setError(r.error)));
  }, []);
  return (
    <section className="admin-card" aria-label="Japan">
      <h2>Japan</h2>
      {error && <p role="alert" className="admin-msg admin-msg-error">Could not load Japan status: {error}</p>}
      {!jp && !error && <p className="admin-muted">Loading…</p>}
      {jp && (
        <>
          <p>Full level {jp.full} · Basic level {jp.basic}</p>
          <p>SEC access: {jp.secConfigured ? 'configured' : 'not configured (set SEC_USER_AGENT)'}</p>
          <p>EDINET key: {jp.edinetConfigured ? 'configured' : 'not configured (set EDINET_API_KEY)'}</p>
          <p>6-K reader: {jp.readerOn ? 'on' : 'off until 20 releases and the held-out set are read exactly right'}</p>
          <p>Last 6-K seen: {when(jp.lastSixKAt)}</p>
          <p>Last EDINET document: {when(jp.lastEdinetAt)}</p>
        </>
      )}
    </section>
  );
}

/** UK and Europe coverage, keys, Tradegate and feed freshness. Read-only. */
function EuropePanel() {
  const [eu, setEu] = useState<EuropeAdminDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetchEuropeAdmin().then((r) => (r.ok ? setEu(r.data) : setError(r.error)));
  }, []);
  const tg = eu?.tradegate;
  return (
    <section className="admin-card" aria-label="UK and Europe">
      <h2>UK and Europe</h2>
      {error && <p role="alert" className="admin-msg admin-msg-error">Could not load UK and Europe status: {error}</p>}
      {!eu && !error && <p className="admin-muted">Loading…</p>}
      {eu && tg && (
        <>
          {(['UK', 'EU'] as const).map((m) => (
            <p key={m}>
              {m === 'UK' ? 'UK' : 'Europe'}: Full level {eu[m].full} · Basic level {eu[m].basic} · Inactive {eu[m].inactive} · Left out {eu[m].leftOut ?? '—'}
            </p>
          ))}
          <p>SEC access: {eu.secConfigured ? 'configured' : 'not configured (set SEC_USER_AGENT)'}</p>
          <p>OpenFIGI key: {eu.openFigiConfigured ? 'configured' : 'not configured (optional, OPENFIGI_API_KEY)'}</p>
          <p>
            Tradegate real-time prices:{' '}
            {tg.state == null ? 'unknown' : tg.state === 'on' ? 'on' : tg.state === 'off-env' ? 'off (TRADEGATE_PRICES=0)' : tg.state === 'off-robots' ? 'blocked by robots.txt' : tg.backoffUntil ? <>paused after 429 until {when(tg.backoffUntil)}</> : 'paused after 429/403 (end time unknown)'}
            {' · '}Last Tradegate poll: {when(tg.lastPollAt)}
          </p>
          <p>Universe refreshed: UK {when(eu.UK.lastUniverseAt)} · Europe {when(eu.EU.lastUniverseAt)}</p>
          <p>Last PR Newswire item: UK {when(eu.UK.lastPrnAt)} · Europe {when(eu.EU.lastPrnAt)}</p>
          <p>Last DILA document: {when(eu.EU.lastDilaAt)}</p>
          <p>Last ESEF filing: UK {when(eu.UK.lastEsefAt)} · Europe {when(eu.EU.lastEsefAt)}</p>
          <p>Last 6-K seen: UK {when(eu.UK.lastSixKAt)} · Europe {when(eu.EU.lastSixKAt)}</p>
          {(['UK', 'EU'] as const).map((m) => (
            <p key={`reader-${m}`}>
              6-K reader {m === 'UK' ? 'UK' : 'Europe'}: {eu[m].readerOn ? 'on' : 'off until 20 releases and the held-out set are read exactly right'}
            </p>
          ))}
        </>
      )}
    </section>
  );
}

/** Hong Kong coverage and SEC settings. Read-only. */
function HongKongPanel() {
  const [hk, setHk] = useState<HkAdminDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetchHkAdmin().then((r) => (r.ok ? setHk(r.data) : setError(r.error)));
  }, []);
  return (
    <section className="admin-card" aria-label="Hong Kong">
      <h2>Hong Kong</h2>
      {error && <p role="alert" className="admin-msg admin-msg-error">Could not load Hong Kong status: {error}</p>}
      {!hk && !error && <p className="admin-muted">Loading…</p>}
      {hk && (
        <>
          <p>Full level {hk.full} · Basic level {hk.basic}</p>
          <p>SEC access: {hk.secConfigured ? 'configured' : 'not configured (set SEC_USER_AGENT)'}</p>
          <p>6-K reader: {hk.readerOn ? 'on' : 'off until 20 releases are read exactly right'}</p>
          <p>Last 6-K seen: {when(hk.lastSixKAt)}</p>
        </>
      )}
    </section>
  );
}

export function AdminPage() {
  const account = useAccount();
  const isAdmin = account?.isAdmin === true;
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [notice, setNotice] = useState<Msg>(null);

  const load = useCallback(async () => {
    const res = await listUsers();
    if (res.ok) {
      setUsers(res.data);
      setLoadError(null);
    } else setLoadError(res.error);
  }, []);

  useEffect(() => { if (isAdmin) void load(); }, [isAdmin, load]);

  if (!isAdmin) {
    return (
      <main className="admin admin-denied">
        <h1>Admins only</h1>
        <p><a href="/">Back to the calendar</a></p>
      </main>
    );
  }

  const admins = users?.filter((u) => u.isAdmin).length ?? 0;

  return (
    <div className="admin">
      <header className="admin-top">
        <div className="admin-brand">Earnings</div>
        <nav className="admin-nav" aria-label="Account">
          <a href="/">Back to the calendar</a>
          <span className="admin-muted">{account.userId}</span>
          <button type="button" onClick={account.signOut}>Sign out</button>
        </nav>
      </header>

      <main className="admin-main">
        <div className="admin-head">
          <h1>Users</h1>
          {users && (
            <p className="admin-muted">
              {users.length} user{users.length === 1 ? '' : 's'} · {admins} admin{admins === 1 ? '' : 's'}
            </p>
          )}
        </div>

        <div className="admin-layout">
          <section className="admin-list" aria-label="All users">
            <Message msg={notice} />
            {loadError && (
              <div className="admin-msg admin-msg-error" role="alert">
                Could not load users: {loadError} <button type="button" onClick={() => void load()}>Try again</button>
              </div>
            )}
            {!users && !loadError && <p className="admin-muted">Loading users…</p>}
            {users && (
              <table className="admin-table">
                <thead>
                  <tr>
                    <th scope="col">ID</th>
                    <th scope="col">Role</th>
                    <th scope="col">Created</th>
                    <th scope="col">Last sign-in</th>
                    <th scope="col"><span className="admin-sr">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <UserRows
                      key={u.id} user={u} self={u.id === account.userId} editing={editing === u.id}
                      onEdit={() => { setEditing(u.id); setNotice(null); }}
                      onCancel={() => setEditing(null)}
                      onSaved={(newId) => { setEditing(null); setNotice({ kind: 'ok', text: `Saved ${newId}` }); void load(); }}
                      onDeleted={() => { setNotice({ kind: 'ok', text: `Deleted ${u.id}` }); void load(); }}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <aside className="admin-forms">
            <AddUserForm onAdded={() => void load()} />
            <AddManyForm onAdded={() => void load()} />
            <ZerodhaPanel />
            <HongKongPanel />
            <JapanPanel />
            <EuropePanel />
          </aside>
        </div>
      </main>
    </div>
  );
}

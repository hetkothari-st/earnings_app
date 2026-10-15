import { useCallback, useEffect, useState } from 'react';
import { fetchAccount } from './adminApi';
import { logout, UNAUTHORIZED_EVENT } from './api';
import { AdminPage } from './components/AdminPage';
import { Calendar } from './components/Calendar';
import { LoginPage } from './components/LoginPage';
import { StatusPage } from './components/StatusPage';
import { AccountContext } from './lib/account';

type Auth = { status: 'checking' } | { status: 'out' } | { status: 'in'; id: string; isAdmin: boolean } | { status: 'error' };

export default function App() {
  const [auth, setAuth] = useState<Auth>({ status: 'checking' });

  const check = useCallback(() => {
    fetchAccount()
      .then((me) => setAuth(me ? { status: 'in', id: me.id, isAdmin: me.isAdmin } : { status: 'out' }))
      .catch(() => setAuth({ status: 'error' }));
  }, []);

  useEffect(check, [check]);
  useEffect(() => {
    const onUnauthorized = () => setAuth({ status: 'out' });
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const signOut = useCallback(() => {
    void logout().catch(() => {}).finally(() => setAuth({ status: 'out' }));
  }, []);

  if (auth.status === 'checking') return null;
  if (auth.status === 'error') {
    return (
      <main className="page">
        <p className="warn-text">Could not reach the server.</p>
        <button onClick={check}>Try again</button>
      </main>
    );
  }
  if (auth.status === 'out') return <LoginPage onSignedIn={check} />;
  // Keyed by user so per-user state (expanded list) reloads after switching accounts.
  const path = window.location.pathname;
  return (
    <AccountContext.Provider value={{ userId: auth.id, isAdmin: auth.isAdmin, signOut }}>
      {path === '/status' ? <StatusPage /> : path === '/admin' ? <AdminPage key={auth.id} /> : <Calendar key={auth.id} />}
    </AccountContext.Provider>
  );
}

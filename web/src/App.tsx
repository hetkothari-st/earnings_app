import { useCallback, useEffect, useState } from 'react';
import { fetchMe, logout, UNAUTHORIZED_EVENT } from './api';
import { Calendar } from './components/Calendar';
import { LoginPage } from './components/LoginPage';
import { StatusPage } from './components/StatusPage';

type Auth = { status: 'checking' } | { status: 'out' } | { status: 'in'; id: string } | { status: 'error' };

export default function App() {
  const [auth, setAuth] = useState<Auth>({ status: 'checking' });

  const check = useCallback(() => {
    fetchMe()
      .then((me) => setAuth(me ? { status: 'in', id: me.id } : { status: 'out' }))
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
  // Keyed by user so per-user state (hidden list) reloads after switching accounts.
  return window.location.pathname === '/status'
    ? <StatusPage />
    : <Calendar key={auth.id} userId={auth.id} onSignOut={signOut} />;
}

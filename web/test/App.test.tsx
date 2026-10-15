import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from '../src/App';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let signedIn: boolean;
let earningsStatus: number;
let calls: { url: string; method: string }[];

beforeEach(() => {
  signedIn = false;
  earningsStatus = 200;
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method });
    const path = url.split('?')[0];
    if (path === '/api/login') {
      const body = JSON.parse(String(init!.body)) as { id: string; password: string };
      if (body.password !== '00000000') return json(401, { error: 'Wrong user ID or password' });
      signedIn = true;
      return new Response(null, { status: 204 });
    }
    if (path === '/api/logout') { signedIn = false; return new Response(null, { status: 204 }); }
    if (!signedIn) return json(401, { error: 'Not signed in' });
    if (path === '/api/me') return json(200, { id: '1A' });
    if (path === '/api/hidden') return json(200, { symbols: [] });
    if (path === '/api/markets') return json(200, { indices: [] });
    if (path === '/api/earnings') return earningsStatus === 200 ? json(200, { rows: [], sources: [] }) : json(earningsStatus, {});
    return json(404, {});
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

async function signIn() {
  fireEvent.change(await screen.findByLabelText('User ID'), { target: { value: '1a' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: '00000000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('button', { name: 'Sign out' });
}

test('shows the login page when there is no session', async () => {
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
});

test('goes straight to the calendar with an existing session', async () => {
  signedIn = true;
  render(<App />);
  expect(await screen.findByRole('button', { name: 'Sign out' })).toBeTruthy();
  expect(screen.getByText('1A')).toBeTruthy();
  expect(screen.queryByLabelText('User ID')).toBeNull();
});

test('signing in shows the calendar', async () => {
  render(<App />);
  await signIn();
  expect(screen.queryByLabelText('User ID')).toBeNull();
  await waitFor(() => expect(calls.some((c) => c.url.startsWith('/api/earnings'))).toBe(true));
});

test('sign out ends the session and returns to the login page', async () => {
  signedIn = true;
  render(<App />);
  fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
  expect(await screen.findByLabelText('User ID')).toBeTruthy();
  expect(calls).toContainEqual({ url: '/api/logout', method: 'POST' });
});

test('a 401 while using the app returns to the login page', async () => {
  signedIn = true;
  render(<App />);
  await screen.findByRole('button', { name: 'Sign out' });
  await act(async () => {
    signedIn = false;
    window.dispatchEvent(new Event('auth:unauthorized'));
  });
  expect(await screen.findByLabelText('User ID')).toBeTruthy();
});

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { LoginPage } from '../src/components/LoginPage';

afterEach(() => { vi.unstubAllGlobals(); });

const fill = (id: string, pw: string) => {
  fireEvent.change(screen.getByLabelText('User ID'), { target: { value: id } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: pw } });
};

test('labelled fields, sentence-case button, user ID field focused first', () => {
  render(<LoginPage onSignedIn={() => {}} />);
  const id = screen.getByLabelText('User ID') as HTMLInputElement;
  expect(id.autocomplete).toBe('username');
  expect(document.activeElement).toBe(id);
  expect((screen.getByLabelText('Password') as HTMLInputElement).type).toBe('password');
  expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
});

test('Enter submits; shows a pending state; signs in on success', async () => {
  let resolve!: (r: Response) => void;
  const f = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
  vi.stubGlobal('fetch', f);
  const onSignedIn = vi.fn();
  render(<LoginPage onSignedIn={onSignedIn} />);
  fill('1a', '00000000');
  fireEvent.submit(screen.getByLabelText('Password').closest('form')!);
  const button = await screen.findByRole('button', { name: 'Signing in…' });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(f).toHaveBeenCalledTimes(1);
  await act(async () => { resolve(new Response(null, { status: 204 })); });
  await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
});

test('shows the server error inline and clears the password', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Wrong user ID or password' }), { status: 401 })));
  const onSignedIn = vi.fn();
  render(<LoginPage onSignedIn={onSignedIn} />);
  fill('1A', 'nope');
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Wrong user ID or password');
  expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
  expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBe('true');
  expect(onSignedIn).not.toHaveBeenCalled();
});

test('empty fields are caught before calling the server', () => {
  const f = vi.fn();
  vi.stubGlobal('fetch', f);
  render(<LoginPage onSignedIn={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(screen.getByRole('alert').textContent).toBe('Enter your user ID and password.');
  expect(f).not.toHaveBeenCalled();
});

test('show/hide password toggle', () => {
  render(<LoginPage onSignedIn={() => {}} />);
  const pw = screen.getByLabelText('Password') as HTMLInputElement;
  const toggle = screen.getByRole('button', { name: 'Show password' });
  expect(toggle.getAttribute('type')).toBe('button');
  fireEvent.click(toggle);
  expect(pw.type).toBe('text');
  expect(screen.getByRole('button', { name: 'Hide password' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
  expect(pw.type).toBe('password');
});

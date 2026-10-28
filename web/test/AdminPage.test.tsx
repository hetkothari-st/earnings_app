import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bulkIds, bulkPreview } from '../src/adminApi';
import { AdminPage } from '../src/components/AdminPage';
import { AccountContext } from '../src/lib/account';

interface User { id: string; isAdmin: boolean; createdAt: string; lastLoginAt: string | null }
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

let users: User[];
let calls: { url: string; method: string; body: unknown }[];
let reply: ((url: string, method: string, body: unknown) => Response | undefined) | null;

beforeEach(() => {
  users = [
    { id: '1A', isAdmin: false, createdAt: '2026-10-01T09:00:00.000Z', lastLoginAt: '2026-10-14T13:05:00.000Z' },
    { id: 'BOSS', isAdmin: true, createdAt: '2026-10-01T09:00:00.000Z', lastLoginAt: null },
  ];
  calls = [];
  reply = null;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const custom = reply?.(url, method, body);
    if (custom) return custom;
    if (url === '/api/admin/users' && method === 'GET') return json(200, users);
    if (url === '/api/admin/users' && method === 'POST') {
      const u = { id: String(body.id).toUpperCase(), isAdmin: !!body.isAdmin, createdAt: '2026-10-15T12:00:00.000Z', lastLoginAt: null };
      users = [...users, u];
      return json(201, u);
    }
    if (url === '/api/admin/users/bulk') {
      const made = bulkIds(body.prefix, body.start, body.count, body.suffix)
        .map((id) => ({ id, isAdmin: false, createdAt: '2026-10-15T12:00:00.000Z', lastLoginAt: null }));
      users = [...users, ...made];
      return json(201, made);
    }
    const m = /^\/api\/admin\/users\/(.+)$/.exec(url);
    if (m && method === 'DELETE') {
      users = users.filter((u) => u.id !== decodeURIComponent(m[1]!));
      return new Response(null, { status: 204 });
    }
    if (m && method === 'PATCH') {
      const id = decodeURIComponent(m[1]!);
      users = users.map((u) => (u.id === id ? { ...u, id: body.newId ? String(body.newId).toUpperCase() : u.id, isAdmin: body.isAdmin ?? u.isAdmin } : u));
      return json(200, users.find((u) => u.id === (body.newId ? String(body.newId).toUpperCase() : id)));
    }
    return json(404, {});
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

function renderPage(account = { userId: 'BOSS', isAdmin: true }) {
  return render(
    <AccountContext.Provider value={{ ...account, signOut: () => {} }}>
      <AdminPage />
    </AccountContext.Provider>,
  );
}
const row = async (id: string) => (await screen.findByRole('rowheader', { name: id })).closest('tr')!;

describe('bulk naming', () => {
  test('prefix + number + suffix, uppercased like the server stores them', () => {
    expect(bulkIds('', 11, 5, 'a')).toEqual(['11A', '12A', '13A', '14A', '15A']);
    expect(bulkIds('desk-', 1, 2, '')).toEqual(['DESK-1', 'DESK-2']);
  });
  test('preview text', () => {
    expect(bulkPreview('', 11, 5, 'A')).toBe('11A … 15A (5 users)');
    expect(bulkPreview('', 7, 1, '')).toBe('7 (1 user)');
    expect(bulkPreview('', 1, 0, '')).toBeNull();
    expect(bulkPreview('', 1, 201, '')).toBeNull();
    expect(bulkPreview('', -1, 2, '')).toBeNull();
    expect(bulkPreview('a b', 1, 2, '')).toBeNull();
  });
});

describe('admin page', () => {
  test('non-admins see a short message and nothing is fetched', () => {
    renderPage({ userId: '1A', isAdmin: false });
    expect(screen.getByText('Admins only')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(calls).toEqual([]);
  });

  test('Hong Kong panel shows reader off and SEC configured', async () => {
    reply = (url) => (url === '/api/admin/hk'
      ? json(200, { full: 14, basic: 6, secConfigured: true, readerOn: false, lastSixKAt: '2026-10-26T04:00:00.000Z' })
      : undefined);
    renderPage();
    const panel = (await screen.findByRole('region', { name: 'Hong Kong' }));
    await waitFor(() => expect(panel.textContent).toContain('Full level 14 · Basic level 6'));
    expect(panel.textContent).toContain('SEC access: configured');
    expect(panel.textContent).toContain('6-K reader: off until 20 releases are read exactly right');
    expect(panel.textContent).toContain('Last 6-K seen:');
    expect(panel.textContent).not.toContain('Never');
  });

  test('Europe panel: Tradegate paused until, OpenFIGI not configured, readers off', async () => {
    const m = (full: number, basic: number, inactive: number, leftOut: number) => ({
      full, basic, inactive, leftOut, lastUniverseAt: '2026-10-27T03:00:00.000Z', lastSixKAt: null,
      lastPrnAt: '2026-10-28T06:02:00.000Z', lastDilaAt: '2026-10-28T05:45:00.000Z', lastEsefAt: null, readerOn: false,
    });
    reply = (url) => (url === '/api/admin/europe'
      ? json(200, {
        UK: m(12, 1400, 30, 13), EU: m(33, 3000, 41, 12),
        tradegate: { state: 'backoff', backoffUntil: '2026-10-28T11:30:00.000Z', lastPollAt: '2026-10-28T10:29:00.000Z' },
        secConfigured: true, openFigiConfigured: false,
      })
      : undefined);
    renderPage();
    const panel = await screen.findByRole('region', { name: 'UK and Europe' });
    await waitFor(() => expect(panel.textContent).toContain('UK: Full level 12 · Basic level 1400 · Inactive 30 · Left out 13'));
    expect(panel.textContent).toContain('Europe: Full level 33 · Basic level 3000 · Inactive 41 · Left out 12');
    expect(panel.textContent).toContain('SEC access: configured');
    expect(panel.textContent).toContain('OpenFIGI key: not configured (optional, OPENFIGI_API_KEY)');
    expect(panel.textContent).toContain('Tradegate real-time prices: paused after 429 until Oct 28, 2026');
    expect(panel.textContent).toContain('Last Tradegate poll: Oct 28, 2026');
    expect(panel.textContent).toContain('Universe refreshed:');
    expect(panel.textContent).toContain('Last PR Newswire item:');
    expect(panel.textContent).toContain('Last DILA document:');
    expect(panel.textContent).toContain('Last ESEF filing:');
    expect(panel.textContent).toContain('6-K reader UK: off until 20 releases and the held-out set are read exactly right');
    expect(panel.textContent).toContain('6-K reader Europe: off until 20 releases and the held-out set are read exactly right');
  });

  test('Europe panel: unknown Tradegate state is never shown as on; unknown left-out is a dash', async () => {
    const m = { full: 1, basic: 2, inactive: 3, leftOut: null, lastUniverseAt: null, lastSixKAt: null, lastPrnAt: null, lastDilaAt: null, lastEsefAt: null, readerOn: true };
    reply = (url) => (url === '/api/admin/europe'
      ? json(200, { UK: m, EU: m, tradegate: { state: null, backoffUntil: null, lastPollAt: null }, secConfigured: false, openFigiConfigured: true })
      : undefined);
    renderPage();
    const panel = await screen.findByRole('region', { name: 'UK and Europe' });
    await waitFor(() => expect(panel.textContent).toContain('UK: Full level 1 · Basic level 2 · Inactive 3 · Left out —'));
    expect(panel.textContent).toContain('Tradegate real-time prices: unknown');
    expect(panel.textContent).toContain('SEC access: not configured (set SEC_USER_AGENT)');
    expect(panel.textContent).toContain('OpenFIGI key: configured');
    expect(panel.textContent).toContain('6-K reader UK: on');
  });

  test('Europe panel: backoff with no end time never reads until Never', async () => {
    const m = { full: 1, basic: 2, inactive: 3, leftOut: 4, lastUniverseAt: null, lastSixKAt: null, lastPrnAt: null, lastDilaAt: null, lastEsefAt: null, readerOn: false };
    reply = (url) => (url === '/api/admin/europe'
      ? json(200, { UK: m, EU: m, tradegate: { state: 'backoff', backoffUntil: null, lastPollAt: null }, secConfigured: true, openFigiConfigured: true })
      : undefined);
    renderPage();
    const panel = await screen.findByRole('region', { name: 'UK and Europe' });
    await waitFor(() => expect(panel.textContent).toContain('Tradegate real-time prices: paused after 429/403 (end time unknown)'));
    expect(panel.textContent).not.toContain('until Never');
  });

  test('Japan panel shows EDINET key not configured and reader off', async () => {
    reply = (url) => (url === '/api/admin/jp'
      ? json(200, { full: 9, basic: 30, secConfigured: true, edinetConfigured: false, readerOn: false, lastSixKAt: null, lastEdinetAt: null })
      : undefined);
    renderPage();
    const panel = (await screen.findByRole('region', { name: 'Japan' }));
    await waitFor(() => expect(panel.textContent).toContain('Full level 9 · Basic level 30'));
    expect(panel.textContent).toContain('EDINET key: not configured (set EDINET_API_KEY)');
    expect(panel.textContent).toContain('6-K reader: off until 20 releases and the held-out set are read exactly right');
    expect(panel.textContent).toContain('Last EDINET document:');
  });

  test('lists users with role, created and last sign-in', async () => {
    renderPage();
    const one = await row('1A');
    expect(within(one).getByText('User')).toBeTruthy();
    expect(within(one).queryByText('Never')).toBeNull();
    const boss = await row('BOSS');
    expect(within(boss).getByText('Admin')).toBeTruthy();
    expect(within(boss).getByText('Never')).toBeTruthy();
    // You cannot delete yourself, so your own row has no Delete button.
    expect(within(boss).queryByRole('button', { name: /Delete/ })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to the calendar' }).getAttribute('href')).toBe('/');
  });

  test('add user: posts the ID and password, shows success and the new row', async () => {
    renderPage();
    await row('1A');
    const form = screen.getByRole('form', { name: 'Add user' });
    fireEvent.change(within(form).getByLabelText('User ID'), { target: { value: 'jane@example.com' } });
    const pw = within(form).getByLabelText('Password') as HTMLInputElement;
    fireEvent.change(pw, { target: { value: 'secret-pass' } });
    expect(pw.type).toBe('password');
    fireEvent.click(within(form).getByRole('button', { name: 'Show password' }));
    expect(pw.type).toBe('text');
    fireEvent.click(within(form).getByRole('button', { name: 'Add user' }));
    expect(await within(form).findByText('Added JANE@EXAMPLE.COM')).toBeTruthy();
    expect(calls).toContainEqual({ url: '/api/admin/users', method: 'POST', body: { id: 'jane@example.com', password: 'secret-pass', isAdmin: false } });
    expect(await row('JANE@EXAMPLE.COM')).toBeTruthy();
    expect(pw.value).toBe('');
  });

  test('add user: shows the server error inline', async () => {
    reply = (url, method) => (url === '/api/admin/users' && method === 'POST' ? json(409, { error: 'User 1A already exists' }) : undefined);
    renderPage();
    await row('1A');
    const form = screen.getByRole('form', { name: 'Add user' });
    fireEvent.change(within(form).getByLabelText('User ID'), { target: { value: '1a' } });
    fireEvent.change(within(form).getByLabelText('Password'), { target: { value: 'secret-pass' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add user' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('User 1A already exists');
  });

  test('add user: checks length before calling the server', async () => {
    renderPage();
    await row('1A');
    const form = screen.getByRole('form', { name: 'Add user' });
    fireEvent.change(within(form).getByLabelText('User ID'), { target: { value: 'x' } });
    fireEvent.change(within(form).getByLabelText('Password'), { target: { value: 'short' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add user' }));
    expect((await within(form).findByRole('alert')).textContent).toMatch(/at least 8/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  test('add many: live preview, then creates the users', async () => {
    renderPage();
    await row('1A');
    const form = screen.getByRole('form', { name: 'Add many' });
    fireEvent.change(within(form).getByLabelText('Start number'), { target: { value: '11' } });
    fireEvent.change(within(form).getByLabelText('Count'), { target: { value: '5' } });
    fireEvent.change(within(form).getByLabelText('Suffix'), { target: { value: 'a' } });
    expect(within(form).getByText('11A … 15A (5 users)')).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Shared password'), { target: { value: 'shared-pass' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add 5 users' }));
    expect(await within(form).findByText('Added 5 users: 11A … 15A')).toBeTruthy();
    expect(calls).toContainEqual({
      url: '/api/admin/users/bulk', method: 'POST', body: { prefix: '', start: 11, count: 5, suffix: 'a', password: 'shared-pass' },
    });
    expect(await row('15A')).toBeTruthy();
  });

  test('add many: a clash is reported inline', async () => {
    reply = (url) => (url === '/api/admin/users/bulk' ? json(409, { error: 'These user IDs already exist: 1A', existing: ['1A'] }) : undefined);
    renderPage();
    await row('1A');
    const form = screen.getByRole('form', { name: 'Add many' });
    fireEvent.change(within(form).getByLabelText('Count'), { target: { value: '2' } });
    fireEvent.change(within(form).getByLabelText('Suffix'), { target: { value: 'A' } });
    fireEvent.change(within(form).getByLabelText('Shared password'), { target: { value: 'shared-pass' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add 2 users' }));
    expect((await within(form).findByRole('alert')).textContent).toBe('These user IDs already exist: 1A');
  });

  test('delete asks for confirmation inline; cancel keeps the user, confirm deletes', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    renderPage();
    let r = await row('1A');
    fireEvent.click(within(r).getByRole('button', { name: 'Delete' }));
    expect(within(r).getByText(/Delete 1A\?/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.click(within(r).getByRole('button', { name: 'Cancel' }));
    expect(within(r).queryByText(/Delete 1A\?/)).toBeNull();

    r = await row('1A');
    fireEvent.click(within(r).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(r).getByRole('button', { name: 'Delete 1A' }));
    await waitFor(() => expect(screen.queryByRole('rowheader', { name: '1A' })).toBeNull());
    expect(calls).toContainEqual({ url: '/api/admin/users/1A', method: 'DELETE', body: undefined });
    expect(screen.getByText('Deleted 1A')).toBeTruthy();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  test('edit: change password, rename and toggle admin inline', async () => {
    renderPage();
    const r = await row('1A');
    fireEvent.click(within(r).getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('form', { name: 'Edit 1A' });
    fireEvent.change(within(editor).getByLabelText('New password'), { target: { value: 'another-pass' } });
    fireEvent.change(within(editor).getByLabelText('User ID'), { target: { value: 'trader1' } });
    fireEvent.click(within(editor).getByLabelText('Admin'));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved TRADER1')).toBeTruthy();
    expect(calls).toContainEqual({
      url: '/api/admin/users/1A', method: 'PATCH', body: { password: 'another-pass', newId: 'trader1', isAdmin: true },
    });
    expect(await row('TRADER1')).toBeTruthy();
  });

  test('edit: unchanged fields are not sent; nothing changed means no request', async () => {
    renderPage();
    const r = await row('1A');
    fireEvent.click(within(r).getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('form', { name: 'Edit 1A' });
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    expect((await within(editor).findByRole('alert')).textContent).toBe('Nothing to save');
    fireEvent.click(within(editor).getByLabelText('Admin'));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved 1A');
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([{ url: '/api/admin/users/1A', method: 'PATCH', body: { isAdmin: true } }]);
  });

  test('edit errors from the server are shown in the editor', async () => {
    reply = (_url, method) => (method === 'PATCH' ? json(409, { error: 'You cannot remove your own admin role' }) : undefined);
    renderPage();
    const r = await row('BOSS');
    fireEvent.click(within(r).getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('form', { name: 'Edit BOSS' });
    fireEvent.click(within(editor).getByLabelText('Admin'));
    fireEvent.click(within(editor).getByRole('button', { name: 'Save' }));
    expect((await within(editor).findByRole('alert')).textContent).toBe('You cannot remove your own admin role');
  });
});

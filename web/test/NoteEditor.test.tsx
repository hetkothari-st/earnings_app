import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { NoteEditor } from '../src/components/NoteEditor';

afterEach(() => { vi.useRealTimers(); });

test('saves after typing pauses and shows when the note will be deleted', async () => {
  vi.useFakeTimers();
  const onSave = vi.fn().mockResolvedValue(undefined);
  render(<NoteEditor reportId={7} zone="Asia/Kolkata"
    note={{ reportId: 7, text: '', updatedAt: 'x', deleteAt: '2026-10-16T13:30:00.000Z' }} onSave={onSave} />);
  fireEvent.change(screen.getByLabelText('Your notes'), { target: { value: 'watch guidance' } });
  expect(onSave).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(900); });
  expect(onSave).toHaveBeenCalledWith(7, 'watch guidance');
  expect(screen.getByText(/Deleted automatically on Fri 16 Oct, 7:00 PM IST/)).toBeTruthy();
});

test('without a note yet, explains the 24-hour rule', () => {
  render(<NoteEditor reportId={7} zone="Asia/Kolkata" note={undefined} onSave={vi.fn()} />);
  expect(screen.getByText(/deleted 24 hours after the results/i)).toBeTruthy();
});

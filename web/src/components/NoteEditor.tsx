import { DateTime } from 'luxon';
import { useEffect, useRef, useState } from 'react';
import type { Note } from '../api';
import { zoneLabel } from '../lib/time';

const SAVE_AFTER_MS = 800;

/** Free-text note for one report; saved automatically, deleted by the server 24 hours after the results. */
export function NoteEditor({ reportId, zone, note, onSave }: {
  reportId: number; zone: string; note: Note | undefined; onSave: (reportId: number, text: string) => Promise<void>;
}) {
  const [text, setText] = useState(note?.text ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const change = (value: string) => {
    setText(value);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setState('saving');
      onSave(reportId, value).then(() => setState('saved'), () => setState('error'));
    }, SAVE_AFTER_MS);
  };

  const deleteAt = note?.deleteAt
    ? DateTime.fromISO(note.deleteAt).setZone(zone).setLocale('en-US')
    : null;
  return (
    <div className="note">
      <label htmlFor={`note-${reportId}`}>Your notes</label>
      <textarea id={`note-${reportId}`} value={text} maxLength={5000} rows={3}
        placeholder="Only you can see this note." onChange={(e) => change(e.target.value)} />
      <p className="note-meta">
        {deleteAt
          ? `Deleted automatically on ${deleteAt.toFormat('ccc d LLL, h:mm a')} ${zoneLabel(zone, deleteAt.toISODate()!)}.`
          : 'Notes are deleted 24 hours after the results.'}
        {state === 'saving' && ' Saving…'}
        {state === 'saved' && ' Saved.'}
        {state === 'error' && <span className="warn-text"> Not saved. Check your connection.</span>}
      </p>
    </div>
  );
}

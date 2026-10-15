import { act, renderHook } from '@testing-library/react';
import { expect, test } from 'vitest';
import { useHidden } from '../src/hooks/useHidden';

test('toggle hides and unhides, and persists', () => {
  const { result } = renderHook(() => useHidden());
  act(() => result.current.toggle('TSM'));
  expect(result.current.hidden.has('TSM')).toBe(true);
  expect(JSON.parse(localStorage.getItem('hiddenTickers')!)).toEqual(['TSM']);
  const again = renderHook(() => useHidden());
  expect(again.result.current.hidden.has('TSM')).toBe(true);
  act(() => result.current.toggle('TSM'));
  expect(result.current.hidden.has('TSM')).toBe(false);
});

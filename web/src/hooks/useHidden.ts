import { useCallback, useState } from 'react';
import { readJson, writeJson } from '../lib/storage';

const KEY = 'hiddenTickers';

export function useHidden(): { hidden: Set<string>; toggle: (symbol: string) => void } {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(readJson<string[]>(KEY, [])));
  const toggle = useCallback((symbol: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      writeJson(KEY, [...next]);
      return next;
    });
  }, []);
  return { hidden, toggle };
}

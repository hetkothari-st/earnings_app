import { IANAZone } from 'luxon';
import { useState } from 'react';
import { detectZone } from '../lib/time';
import { readJson, writeJson } from '../lib/storage';

const KEY = 'tzOverride';

export function useZone(): { zone: string; isOverride: boolean; setZone: (z: string | null) => void } {
  const [override, setOverride] = useState<string | null>(() => readJson<string | null>(KEY, null));
  const valid = override != null && IANAZone.isValidZone(override);
  return {
    zone: valid ? override : detectZone(),
    isOverride: valid,
    setZone: (z) => {
      setOverride(z);
      writeJson(KEY, z);
    },
  };
}

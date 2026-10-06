import { useCallback, useState } from 'react';

/**
 * A `useState` that survives a reload.
 *
 * Used for viewing preferences — grid vs list, and anything like it — where the
 * value is not part of any server query. Keeping these out of the URL matters:
 * switching layout should not produce a link that reopens the app in one density,
 * and should not invalidate the jobs query, because neither changes *which* jobs
 * come back.
 *
 * Reads localStorage lazily so the first render already has the stored value —
 * no flash of the default. Writes are best-effort: private mode throws, and the
 * preference simply does not persist.
 */
export function useLocalState<T extends string>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored !== null && stored !== '' ? (stored as T) : fallback;
    } catch {
      return fallback;
    }
  });

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, next);
      } catch {
        // Nothing to write to; the value still holds for this session.
      }
    },
    [key],
  );

  return [value, set];
}

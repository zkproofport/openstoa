import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Lazy-require @react-native-async-storage/async-storage from the host's
 * node_modules so this sub-package doesn't have to add it as a peerDep.
 * Matches the expo-image-picker pattern used in PostCreateScreen — keeps
 * the package buildable even when the host hasn't linked the native module
 * yet. If unavailable, draft persistence is a no-op (state still works).
 */
interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

function loadAsyncStorage(): AsyncStorageLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@react-native-async-storage/async-storage');
    return mod?.default ?? mod ?? null;
  } catch {
    return null;
  }
}

const TTL_MS = 24 * 60 * 60 * 1000;
const DEBOUNCE_MS = 1200;

interface DraftEnvelope<T> {
  value: T;
  savedAt: number;
}

/**
 * Persists a value to AsyncStorage under `key` with a 24h TTL and a 1.2s
 * debounce so we don't hammer storage on every keystroke. Returns the most
 * recently loaded draft (or null if absent/expired) plus three actions —
 * `save`, `clear`, and the transient `saved` flag for the "Draft saved"
 * indicator.
 */
export function useDraft<T>(key: string) {
  const [loaded, setLoaded] = useState<T | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [saved, setSaved] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedFadeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const storage = loadAsyncStorage();
      if (!storage) {
        if (!cancelled) setHydrated(true);
        return;
      }
      try {
        const raw = await storage.getItem(key);
        if (!raw) {
          if (!cancelled) setHydrated(true);
          return;
        }
        const env = JSON.parse(raw) as DraftEnvelope<T>;
        if (Date.now() - env.savedAt > TTL_MS) {
          await storage.removeItem(key);
          if (!cancelled) setHydrated(true);
          return;
        }
        if (!cancelled) {
          setLoaded(env.value);
          setHydrated(true);
        }
      } catch {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key]);

  const save = useCallback(
    (value: T) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setSaved(false);
      timerRef.current = setTimeout(async () => {
        const storage = loadAsyncStorage();
        if (!storage) return;
        try {
          await storage.setItem(
            key,
            JSON.stringify({ value, savedAt: Date.now() } satisfies DraftEnvelope<T>),
          );
          setSaved(true);
          if (savedFadeRef.current) clearTimeout(savedFadeRef.current);
          savedFadeRef.current = setTimeout(() => setSaved(false), 2000);
        } catch {
          // Best-effort: swallow storage errors so the editor stays usable.
        }
      }, DEBOUNCE_MS);
    },
    [key],
  );

  const clear = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const storage = loadAsyncStorage();
    if (!storage) return;
    try {
      await storage.removeItem(key);
    } catch {
      // ignore
    }
  }, [key]);

  return { loaded, hydrated, saved, save, clear };
}

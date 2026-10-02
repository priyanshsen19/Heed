import { useCallback, useEffect, useState } from 'react';
import {
  createChromeConnectionSource,
  type ConnectionSource,
  type ConnectionState,
} from '../lib/connection';

export interface UseConnectionState {
  readonly state: ConnectionState;
  readonly retry: () => void;
}

export function useConnectionState(source?: ConnectionSource): UseConnectionState {
  const [state, setState] = useState<ConnectionState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const active = source ?? createChromeConnectionSource();
    let cancelled = false;
    const load = (): void => {
      void active.read().then((next) => {
        if (!cancelled) {
          setState(next);
        }
      });
    };
    load();
    const unsubscribe = active.subscribe(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [source, attempt]);

  const retry = useCallback(() => {
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  return { state, retry };
}

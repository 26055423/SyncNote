import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { Board } from '../workspace/types';

export function useBoard(setError: (message: string) => void) {
  const [board, setBoard] = useState<Board | null>(null);
  /* ---------------------------------------------------------- 看板轮询 */

  useEffect(() => {
    let alive = true, loading = false;
    const controller = new AbortController();
    const load = async () => {
      if (loading) return;
      loading = true;
      try {
        const data = await api<Board>('/api/state?view=board', undefined, { signal: controller.signal });
        if (!alive) return;
        if (data.user.onboarding_step < 4) {
          location.replace('/welcome');
          return;
        }
        setBoard(data);
        setError('');
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      } finally { loading = false; }
    };
    void load();
    const timer = window.setInterval(load, 5000);
    return () => {
      alive = false; controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  return { board, setBoard };
}

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { AuthUser } from '@job-agent/shared';
import { api, onAuthFailure } from './api';
import { tokens } from './token';

/**
 * Auth state for the whole app.
 *
 * On mount we show the cached user immediately (no spinner on every reload) and
 * then confirm it with /auth/me. A rejected /auth/me means the session is gone:
 * tokens are cleared and the shell redirects to /login.
 */
type AuthState = {
  user: AuthUser | null;
  status: 'loading' | 'authenticated' | 'anonymous';
  login: (input: { email: string; password: string }) => Promise<void>;
  register: (input: { email: string; password: string; name?: string }) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const cached = tokens.cachedUser();
  // Optimistic paint from the cached session: enough to render the chrome while
  // /auth/me is in flight. `isAdmin` is deliberately false rather than guessed —
  // it is never read before /auth/me replaces this object, so defaulting it to
  // true would briefly show admin-only UI to a non-admin.
  const [user, setUser] = useState<AuthUser | null>(
    cached
      ? { id: cached.id, email: cached.email, profileId: '', createdAt: '', isAdmin: false }
      : null,
  );
  const [status, setStatus] = useState<AuthState['status']>(
    tokens.access() ? 'loading' : 'anonymous',
  );

  useEffect(() => {
    if (!tokens.access()) return;

    let cancelled = false;
    api
      .me()
      .then((me) => {
        if (cancelled) return;
        setUser(me);
        setStatus('authenticated');
      })
      .catch(() => {
        if (cancelled) return;
        tokens.clear();
        setUser(null);
        setStatus('anonymous');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // A refresh can fail mid-session (revoked, expired, secret rotated). The API
  // layer cannot navigate, so it announces failure and we drop the user here.
  useEffect(
    () =>
      onAuthFailure(() => {
        // Cached jobs belong to whoever owned the dead session; keeping them
        // would show the next person to sign in on this tab someone else's data.
        queryClient.clear();
        setUser(null);
        setStatus('anonymous');
      }),
    [queryClient],
  );

  const login = useCallback(
    async (input: { email: string; password: string }) => {
      const pair = await api.login(input);
      queryClient.clear();
      setUser(pair.user);
      setStatus('authenticated');
    },
    [queryClient],
  );

  const register = useCallback(
    async (input: { email: string; password: string; name?: string }) => {
      const pair = await api.register(input);
      queryClient.clear();
      setUser(pair.user);
      setStatus('authenticated');
    },
    [queryClient],
  );

  const logout = useCallback(async () => {
    await api.logout();
    queryClient.clear();
    setUser(null);
    setStatus('anonymous');
  }, [queryClient]);

  const value = useMemo(
    () => ({ user, status, login, register, logout }),
    [user, status, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

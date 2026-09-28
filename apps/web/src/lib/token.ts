/**
 * Token storage, deliberately isolated from `api.ts` and the auth context.
 *
 * `api.ts` needs the tokens (and the context needs `api.ts`), so keeping the
 * storage here is what stops those two from importing each other in a cycle.
 *
 * sessionStorage, not localStorage: tokens die with the tab, so a shared or
 * abandoned browser does not leave a live session behind. The trade-off is that
 * closing the tab signs the user out, which is why the refresh token exists —
 * it survives a reload but not a closed tab.
 */
const ACCESS_KEY = 'jobagent.access';
const REFRESH_KEY = 'jobagent.refresh';

export type StoredSession = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string;
};

function read(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    // Safari private mode and hardened browsers throw on storage access.
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    // Auth still works for this page load; it just will not survive a reload.
  }
}

export const tokens = {
  access: () => read(ACCESS_KEY),
  refresh: () => read(REFRESH_KEY),

  save(session: StoredSession): void {
    write(ACCESS_KEY, session.accessToken);
    write(REFRESH_KEY, session.refreshToken);
    write('jobagent.user', JSON.stringify({ id: session.userId, email: session.email }));
  },

  clear(): void {
    write(ACCESS_KEY, null);
    write(REFRESH_KEY, null);
    write('jobagent.user', null);
  },

  /** Cached user for an instant first paint, before /auth/me resolves. */
  cachedUser(): { id: string; email: string } | null {
    const raw = read('jobagent.user');
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { id: string; email: string };
    } catch {
      return null;
    }
  },
};

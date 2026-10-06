import { useState } from 'react';
import { NavLink, Route, Routes } from 'react-router';
import { AnonymousRoute, ProtectedRoute } from '@/components/ProtectedRoute';
import { AdminPage } from '@/pages/AdminPage';
import { JobDetailPage } from '@/pages/JobDetailPage';
import { JobsPage } from '@/pages/JobsPage';
import { LoginPage } from '@/pages/LoginPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { RegisterPage } from '@/pages/RegisterPage';
import { RunsPage } from '@/pages/RunsPage';
import { Button, cx } from '@/components/ui';
import { LogoLockup } from '@/components/brand';
import { APP_NAME } from '@/lib/brand';
import { useAuth } from '@/lib/auth';
import { useTheme } from '@/lib/theme';

const NAV = [
  {
    to: '/',
    label: 'Jobs',
    end: true,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className="size-4"
        stroke="currentColor"
        strokeWidth="1.7"
      >
        <rect x="3" y="7" width="18" height="13" rx="2" />
        <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: '/runs',
    label: 'Runs',
    end: false,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className="size-4"
        stroke="currentColor"
        strokeWidth="1.7"
      >
        <path d="M4 12a8 8 0 0 1 13.7-5.7L20 8" strokeLinecap="round" />
        <path d="M20 4v4h-4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M20 12a8 8 0 0 1-13.7 5.7L4 16" strokeLinecap="round" />
        <path d="M4 20v-4h4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    to: '/profile',
    label: 'Profile',
    end: false,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className="size-4"
        stroke="currentColor"
        strokeWidth="1.7"
      >
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20a7 7 0 0 1 14 0" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: '/admin',
    label: 'Admin',
    end: false,
    // Hiding the link is a courtesy, not a control: the API checks ADMIN_EMAILS
    // itself and the page explains a 403 rather than rendering anything.
    adminOnly: true,
    icon: (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        className="size-4"
        stroke="currentColor"
        strokeWidth="1.7"
      >
        <path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 9.5 4.1-1.9 7-5.3 7-9.5V6z" strokeLinejoin="round" />
        <path d="M9.5 12l1.8 1.8L15 10" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

/** Sun/moon toggle. Both icons are always in the DOM and cross-fade. */
function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';

  return (
    <button
      type="button"
      onClick={toggle}
      title={`Switch to ${next} theme`}
      aria-label={`Switch to ${next} theme`}
      className="relative grid size-9 place-items-center rounded-lg border border-line bg-surface text-muted shadow-soft transition-colors hover:border-line-strong hover:text-fg"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className={cx(
          'absolute size-4.5 transition-all duration-200',
          theme === 'dark' ? 'scale-100 rotate-0 opacity-100' : 'scale-50 -rotate-90 opacity-0',
        )}
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" strokeLinejoin="round" />
      </svg>
      <svg
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
        className={cx(
          'absolute size-4.5 transition-all duration-200',
          theme === 'dark' ? 'scale-50 rotate-90 opacity-0' : 'scale-100 rotate-0 opacity-100',
        )}
        stroke="currentColor"
        strokeWidth="1.8"
      >
        <circle cx="12" cy="12" r="4" />
        <path
          d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

/** Menu behind the avatar. Closes on outside click and on Escape. */
function AccountMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const email = user?.email ?? '';
  const initial = (email[0] ?? '?').toUpperCase();

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        aria-expanded={open}
        aria-haspopup="menu"
        title={email}
        className="grid size-9 place-items-center rounded-full bg-accent text-sm font-semibold text-accent-fg shadow-soft transition-transform hover:scale-105"
      >
        {initial}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-2 w-56 animate-fade rounded-xl border border-line bg-surface p-1.5 shadow-pop"
        >
          <div className="border-b border-line px-3 py-2">
            <p className="truncate text-xs font-medium text-fg">{email}</p>
            <p className="text-[0.6875rem] text-subtle">Signed in</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-1 w-full justify-start"
            onClick={() => void logout()}
          >
            Sign out
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The signed-in shell: nav, theme, account. Only mounted when authed. */
function Shell() {
  const { user } = useAuth();
  // `isAdmin` is false until /auth/me answers, so the Admin tab appears one beat
  // after sign-in rather than flashing for everyone on a cached session.
  const nav = NAV.filter((item) => !item.adminOnly || user?.isAdmin);

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-5 py-3">
          <NavLink to="/" className="flex shrink-0 items-center gap-2.5">
            <LogoLockup />
          </NavLink>

          {/* Horizontal pill nav; scrolls rather than wrapping on a narrow screen. */}
          <nav className="-mx-1 flex min-w-0 items-center gap-0.5 overflow-x-auto px-1">
            {nav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cx(
                    'inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-accent-soft text-accent'
                      : 'text-muted hover:bg-surface-3 hover:text-fg',
                  )
                }
              >
                {item.icon}
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <AccountMenu />
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-5 py-8">
        <Routes>
          <Route path="/" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route
            path="*"
            element={
              <div className="py-20 text-center">
                <p className="text-sm font-medium text-fg">Page not found.</p>
                <NavLink to="/" className="mt-2 inline-block text-sm text-accent hover:underline">
                  Back to jobs
                </NavLink>
              </div>
            }
          />
        </Routes>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-5 py-4 text-xs text-subtle">
          <span>{APP_NAME} — postings scored against your resume, not a keyword filter.</span>
          <span>Search now lives on the Jobs tab.</span>
        </div>
      </footer>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route element={<AnonymousRoute />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        {/* Every job/run/profile page lives under this guard, so the nav chrome
            only renders for a signed-in user. */}
        <Route path="*" element={<Shell />} />
      </Route>
    </Routes>
  );
}

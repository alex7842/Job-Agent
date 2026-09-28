import { NavLink, Route, Routes } from 'react-router';
import { AnonymousRoute, ProtectedRoute } from '@/components/ProtectedRoute';
import { DocumentsPage } from '@/pages/DocumentsPage';
import { JobDetailPage } from '@/pages/JobDetailPage';
import { JobsPage } from '@/pages/JobsPage';
import { LoginPage } from '@/pages/LoginPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { RegisterPage } from '@/pages/RegisterPage';
import { RunsPage } from '@/pages/RunsPage';
import { cx } from '@/components/ui';
import { useAuth } from '@/lib/auth';

const NAV = [
  { to: '/', label: 'Jobs', end: true },
  { to: '/runs', label: 'Runs', end: false },
  { to: '/documents', label: 'Documents', end: false },
  { to: '/profile', label: 'Profile', end: false },
];

/** The signed-in shell: nav, account chip, logout. Only mounted when authed. */
function Shell() {
  const { user, logout } = useAuth();

  return (
    <div className="min-h-full">
      <header className="border-b border-neutral-900">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-5 py-4">
          <span className="text-sm font-semibold tracking-tight text-neutral-100">Job Agent</span>
          <nav className="flex gap-1">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cx(
                    'rounded-md px-2.5 py-1 text-sm transition',
                    isActive
                      ? 'bg-neutral-800 text-neutral-50'
                      : 'text-neutral-400 hover:text-neutral-200',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            <span title={user?.email} className="max-w-40 truncate text-xs text-neutral-500">
              {user?.email}
            </span>
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded-md border border-neutral-800 px-2.5 py-1 text-xs text-neutral-400 transition hover:border-neutral-700 hover:text-neutral-200"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-6">
        <Routes>
          <Route path="/" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route
            path="*"
            element={<p className="py-10 text-center text-sm text-neutral-500">Page not found.</p>}
          />
        </Routes>
      </main>
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

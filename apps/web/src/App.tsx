import { NavLink, Route, Routes } from 'react-router';
import { JobDetailPage } from '@/pages/JobDetailPage';
import { JobsPage } from '@/pages/JobsPage';
import { ProfilePage } from '@/pages/ProfilePage';
import { RunsPage } from '@/pages/RunsPage';
import { cx } from '@/components/ui';

const NAV = [
  { to: '/', label: 'Jobs', end: true },
  { to: '/runs', label: 'Runs', end: false },
  { to: '/profile', label: 'Profile', end: false },
];

export function App() {
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
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-6">
        <Routes>
          <Route path="/" element={<JobsPage />} />
          <Route path="/jobs/:id" element={<JobDetailPage />} />
          <Route path="/runs" element={<RunsPage />} />
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

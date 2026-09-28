import { Navigate, Outlet, useLocation } from 'react-router';
import { Spinner } from './ui';
import { useAuth } from '@/lib/auth';

/**
 * Gate for the authenticated pages. While the initial /auth/me call is in
 * flight we show a spinner rather than redirecting, otherwise a reload would
 * bounce a signed-in user to /login for a frame.
 */
export function ProtectedRoute() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return <Spinner label="Signing you in" />;

  if (status === 'anonymous') {
    // `from` lets LoginPage return the user to the page they asked for.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}

/** Keeps a signed-in user off /login and /register. */
export function AnonymousRoute() {
  const { status } = useAuth();
  if (status === 'loading') return <Spinner label="Signing you in" />;
  if (status === 'authenticated') return <Navigate to="/" replace />;
  return <Outlet />;
}

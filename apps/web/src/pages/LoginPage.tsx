import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { AuthCard, AuthError, Field, useAuthForm } from '@/components/AuthForm';
import { useAuth } from '@/lib/auth';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { error, busy, submit } = useAuthForm();

  // Send the user back to the page the guard bounced them off, not always /.
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const onSubmit = submit(async () => {
    await login({ email, password });
    navigate(from, { replace: true });
  });

  return (
    <AuthCard
      title="Sign in"
      subtitle="Your jobs, runs and profile are scoped to your account."
      footer={
        <>
          No account?{' '}
          <Link to="/register" className="text-neutral-200 hover:text-neutral-50">
            Create one
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <AuthError error={error} />

        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Field
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthCard>
  );
}

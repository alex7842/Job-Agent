import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { AuthCard, AuthError, AuthSubmit, Field, useAuthForm } from '@/components/AuthForm';
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
          <Link to="/register" className="font-medium text-accent hover:underline">
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

        <AuthSubmit busy={busy}>{busy ? 'Signing in…' : 'Sign in'}</AuthSubmit>
      </form>
    </AuthCard>
  );
}

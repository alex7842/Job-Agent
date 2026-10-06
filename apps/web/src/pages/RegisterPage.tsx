import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { AuthCard, AuthError, AuthSubmit, Field, useAuthForm } from '@/components/AuthForm';
import { useAuth } from '@/lib/auth';

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const { error, busy, submit } = useAuthForm();

  const onSubmit = submit(async () => {
    await register({ email, password, name: name.trim() || undefined });
    navigate('/', { replace: true });
  });

  return (
    <AuthCard
      title="Create your account"
      subtitle="We'll set up a profile for your searches."
      footer={
        <>
          Already registered?{' '}
          <Link to="/login" className="font-medium text-accent hover:underline">
            Sign in
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
          autoComplete="new-password"
          minLength={8}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <Field
          label="Display name (optional)"
          name="name"
          autoComplete="nickname"
          placeholder="Ada Lovelace"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="text-xs text-subtle">At least 8 characters.</p>

        <AuthSubmit busy={busy}>{busy ? 'Creating…' : 'Create account'}</AuthSubmit>
      </form>
    </AuthCard>
  );
}

import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError } from '@/lib/api';
import { LogoLockup } from '@/components/brand';
import { Button, Input } from '@/components/ui';

/**
 * Shared shell for both auth screens. Kept in one place so login and register
 * cannot drift on spacing, focus order, and error placement.
 */
export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="relative flex min-h-full items-center justify-center px-5 py-12">
      {/* Decorative backdrop: a soft wash behind the card, so the form reads as
          a panel floating over a surface rather than a bare column of inputs. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-linear-to-br from-accent/12 via-transparent to-transparent"
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-7 text-center">
          {/* Bigger than the header lockup: this is the first thing a new user
              sees, and the page has no other chrome to carry the name. */}
          <LogoLockup markClassName="h-10" className="justify-center gap-3" />
          <h1 className="mt-4 text-lg font-semibold tracking-tight text-fg">{title}</h1>
          <p className="mt-1.5 text-sm text-muted">{subtitle}</p>
        </div>

        <div className="rounded-card border border-line bg-surface p-6 shadow-lift">{children}</div>

        <div className="mt-5 text-center text-sm text-subtle">{footer}</div>
      </div>
    </div>
  );
}

export function Field({
  label,
  ...props
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      <Input {...props} />
    </label>
  );
}

export function AuthError({ error }: { error: unknown }) {
  if (!error) return null;
  const message =
    error instanceof ApiError && error.status === 0
      ? 'Cannot reach the API. Is it running?'
      : error instanceof Error
        ? error.message
        : String(error);
  return (
    <div
      role="alert"
      className="rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger"
    >
      {message}
    </div>
  );
}

/** Full-width submit for the auth forms. */
export function AuthSubmit({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
      {children}
    </Button>
  );
}

export function useAuthForm() {
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  /** Wraps a submit so every screen gets the same busy + error handling. */
  const submit = (fn: () => Promise<void>) => async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return { error, busy, submit };
}

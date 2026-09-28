import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { ApiError } from '@/lib/api';

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
    <div className="flex min-h-full items-center justify-center px-5 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="text-sm font-semibold tracking-tight text-neutral-100">Job Agent</span>
          <h1 className="mt-3 text-lg font-semibold text-neutral-50">{title}</h1>
          <p className="mt-1 text-sm text-neutral-500">{subtitle}</p>
        </div>
        {children}
        <div className="mt-6 text-center text-sm text-neutral-500">{footer}</div>
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
      <span className="mb-1.5 block text-xs font-medium text-neutral-400">{label}</span>
      <input
        {...props}
        className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-neutral-600"
      />
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
    <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
      {message}
    </div>
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

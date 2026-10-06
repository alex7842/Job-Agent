import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
import { forwardRef } from 'react';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------- surfaces ----------

export function Card({
  children,
  className,
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'article' | 'li';
}) {
  return (
    <Tag
      className={cx(
        'rounded-card border border-line bg-surface shadow-soft transition-shadow',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/**
 * A card with a heading. `hint` renders as muted supporting copy under the
 * title rather than a tooltip, so the explanation is discoverable.
 */
export function CardSection({
  title,
  hint,
  icon,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  hint?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={className}>
      <header className="flex flex-wrap items-start gap-3 border-b border-line px-5 py-4">
        {icon ? (
          <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold tracking-tight text-fg">{title}</h2>
          {hint ? <p className="mt-0.5 text-xs leading-relaxed text-subtle">{hint}</p> : null}
        </div>
        {actions}
      </header>
      <div className={cx('p-5', bodyClassName)}>{children}</div>
    </Card>
  );
}

/** Small uppercase label used above groups of inputs. */
export function FieldLabel({
  children,
  hint,
  htmlFor,
}: {
  children: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-1.5">
      <label
        htmlFor={htmlFor}
        className="block text-xs font-semibold tracking-wide text-muted uppercase"
      >
        {children}
      </label>
      {hint ? <p className="text-xs leading-relaxed text-subtle">{hint}</p> : null}
    </div>
  );
}

// ---------- controls ----------

const CONTROL_BASE =
  'w-full rounded-lg border border-line bg-surface-2 text-sm text-fg shadow-soft transition-colors placeholder:text-subtle focus:border-accent focus:bg-surface focus:outline-none focus:ring-4 focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cx(CONTROL_BASE, 'h-10 px-3', className)} {...props} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea ref={ref} className={cx(CONTROL_BASE, 'resize-y px-3 py-2', className)} {...props} />
  );
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...props }, ref) {
    return (
      <div className="relative">
        <select
          ref={ref}
          className={cx(
            CONTROL_BASE,
            'h-10 cursor-pointer appearance-none py-0 pr-9 pl-3',
            className,
          )}
          {...props}
        >
          {children}
        </select>
        {/* Chevron, so the control does not depend on the UA's OS-specific
            select rendering (which ignores `appearance-none` inconsistently). */}
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="none"
          className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-subtle"
        >
          <path
            d="m6 8 4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    );
  },
);

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-accent-fg shadow-soft hover:bg-accent-hover active:translate-y-px disabled:hover:bg-accent',
  secondary:
    'border border-line bg-surface text-fg shadow-soft hover:border-line-strong hover:bg-surface-2 active:translate-y-px',
  subtle: 'bg-surface-3 text-fg hover:bg-line',
  ghost: 'text-muted hover:bg-surface-3 hover:text-fg',
  danger: 'border border-danger/30 bg-danger-bg text-danger hover:bg-danger/15',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 rounded-lg px-2.5 text-xs',
  md: 'h-10 gap-2 rounded-lg px-3.5 text-sm',
  lg: 'h-11 gap-2 rounded-xl px-5 text-sm',
};

export function Button({
  children,
  className,
  variant = 'secondary',
  size = 'md',
  loading,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}) {
  return (
    <button
      className={cx(
        'inline-flex items-center justify-center font-medium transition-all',
        'disabled:cursor-not-allowed disabled:opacity-50',
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
      disabled={loading || props.disabled}
      {...props}
    >
      {loading ? <SpinnerRing className="size-3.5" /> : null}
      {children}
    </button>
  );
}

/**
 * Segmented control. Used for anything with 2–4 mutually exclusive options
 * (sort, layout, view mode) where a dropdown would hide the alternatives.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
  label,
}: {
  value: T;
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
  className?: string;
  label?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cx(
        'inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-line bg-surface-2 p-0.5 shadow-soft',
        className,
      )}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cx(
              'inline-flex h-7 items-center gap-1.5 rounded-[0.4rem] px-2.5 text-xs font-medium transition',
              active
                ? 'bg-surface text-fg shadow-soft ring-1 ring-line'
                : 'text-subtle hover:text-muted',
            )}
          >
            {option.icon}
            <span className={cx(option.icon ? 'hidden sm:inline' : undefined)}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Checkbox styled as a switch. Still a real checkbox, so it is keyboard-native. */
export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-3 select-none',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          // 24px of height and 44px of width: the WCAG 2.5.8 target minimum,
          // which a 20px track falls just under.
          'relative mt-px h-6 w-11 shrink-0 rounded-full transition-colors',
          checked ? 'bg-accent' : 'bg-line-strong',
        )}
      >
        <span
          className={cx(
            'absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform',
            checked && 'translate-x-5',
          )}
        />
      </button>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-fg">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-subtle">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Chips for a list of short values (parsed skills, sources, board tokens). */
export function ChipList({
  items,
  empty = 'none',
  tone = 'neutral',
}: {
  items: string[];
  empty?: string;
  tone?: 'neutral' | 'accent' | 'success';
}) {
  if (items.length === 0) return <span className="text-xs text-subtle italic">{empty}</span>;
  const toneClass = {
    neutral: 'bg-surface-3 text-muted',
    accent: 'bg-accent-soft text-accent',
    success: 'bg-success-bg text-success',
  }[tone];
  return (
    <span className="flex flex-wrap gap-1.5">
      {items.map((item, i) => (
        <span
          key={`${item}-${i}`}
          className={cx('rounded-md px-2 py-0.5 text-xs font-medium', toneClass)}
        >
          {item}
        </span>
      ))}
    </span>
  );
}

// ---------- feedback ----------

export function Badge({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The spinning ring on its own — used inline by `Button` when `loading`. */
export function SpinnerRing({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'inline-block shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70',
        className,
      )}
    />
  );
}

/** Centred loading state for a whole page or panel. */
export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-16 text-sm text-subtle">
      <SpinnerRing className="size-4" />
      {label ? `${label}…` : null}
    </div>
  );
}

export function ErrorNote({ error, className }: { error: unknown; className?: string }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div
      role="alert"
      className={cx(
        'rounded-lg border border-danger/30 bg-danger-bg px-4 py-3 text-sm text-danger',
        className,
      )}
    >
      {message}
    </div>
  );
}

export function Notice({
  tone = 'success',
  children,
  className,
}: {
  tone?: 'success' | 'warn' | 'accent';
  children: ReactNode;
  className?: string;
}) {
  const toneClass = {
    success: 'border-success/30 bg-success-bg text-success',
    warn: 'border-warn/30 bg-warn-bg text-warn',
    accent: 'border-accent/25 bg-accent-soft text-accent',
  }[tone];
  return (
    <div className={cx('rounded-lg border px-4 py-3 text-sm', toneClass, className)}>
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
  action,
}: {
  title: string;
  hint?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-card border border-dashed border-line bg-surface/60 px-6 py-16 text-center">
      {icon ? (
        <span className="mx-auto mb-4 grid size-12 place-items-center rounded-xl bg-surface-3 text-subtle">
          {icon}
        </span>
      ) : null}
      <p className="text-sm font-medium text-fg">{title}</p>
      {hint ? <p className="mx-auto mt-1 max-w-sm text-xs text-subtle">{hint}</p> : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

/** Loading placeholder rows, so a first paint is not a blank list. */
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="skeleton h-24 rounded-card border border-line bg-surface-2"
          style={{ animationDelay: `${i * 90}ms` }}
        />
      ))}
    </div>
  );
}

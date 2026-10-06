import { cx } from './ui';
import { APP_NAME, LOGO_MARK } from '@/lib/brand';

/**
 * The logo mark on its own.
 *
 * Sized by height with `w-auto` because the source PNG is a wide, non-square
 * image — pinning a width would distort it. `shrink-0` matters in the header,
 * where the mark sits next to a flex row that would otherwise squeeze it.
 *
 * `alt` defaults to empty, which is what an assistive technology needs when the
 * mark sits beside the real wordmark: an empty alt is decorative, whereas
 * `alt="Jobly logo"` next to a visible "Jobly" gets read out twice.
 */
export function LogoMark({ className, alt = '' }: { className?: string; alt?: string }) {
  return (
    <img
      src={LOGO_MARK}
      alt={alt}
      className={cx('h-7 w-auto shrink-0 object-contain', className)}
    />
  );
}

/**
 * Mark plus wordmark: the default lockup for the header and the auth screens.
 *
 * The name is real text next to the image rather than `alt` text on it, so it
 * stays readable at any zoom, is translatable, and inherits `text-fg` — which is
 * what keeps it legible when the theme flips.
 */
export function LogoLockup({
  className,
  markClassName,
}: {
  className?: string;
  markClassName?: string;
}) {
  return (
    <span className={cx('inline-flex items-center gap-2.5', className)}>
      <LogoMark className={markClassName} />
      <span className="text-sm font-semibold tracking-tight text-fg">{APP_NAME}</span>
    </span>
  );
}

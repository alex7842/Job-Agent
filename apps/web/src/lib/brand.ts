/**
 * Brand assets and the product name, in one place.
 *
 * The wordmark is HTML text rather than part of the logo image on purpose: the
 * PNGs are fixed-colour artwork, so a wordmark baked into them disappears in one
 * of the two themes. Rendering "Jobly" with a theme token follows the light/dark
 * switch for free and stays selectable and accessible.
 *
 * The mark itself is served from `public/logos`, so Vite copies it verbatim and
 * it is cacheable outside the bundle. Paths are absolute-from-root rather than
 * imported, because these live in `public/`, not `src/assets/`.
 */

/** The wordmark. Keep in sync with <title> in index.html. */
export const APP_NAME = 'Jobly';

/** Icon only — pairs with {@link APP_NAME} for the compact header lockup. */
export const LOGO_MARK = '/logos/jobly-logo-no-text.png';

/** Icon + wordmark baked into one image, for a standalone brand moment. */
export const LOGO_LOCKUP = '/logos/jobly-logo.png';

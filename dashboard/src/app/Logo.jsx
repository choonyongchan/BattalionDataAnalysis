/**
 * The dashboard's mark: a unit shield with the strength bars read out of it.
 *
 * Three bars, not a decorative number — Strength Data splits every company into officer,
 * WOSpec and enlistee, and those three tiers are what the shield is holding. Drawn in
 * `currentColor` so it inverts with the theme and needs no image asset, no second file,
 * and no separate dark version.
 */

/**
 * Renders the brand mark.
 * @param {{size?: number, title?: string}} props Pixel size, and an accessible name.
 * @returns {!preact.VNode} The mark.
 */
export function Logo({ size = 28, title = '40 SAR' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="img"
      aria-label={title}
    >
      <path
        d="M12 2.4 20.4 5.5v6.1c0 4.9-3.4 8.9-8.4 10.6-5-1.7-8.4-5.7-8.4-10.6V5.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <rect x="7.6" y="8.1" width="8.8" height="1.7" rx="0.85" fill="currentColor" />
      <rect x="7.6" y="11.2" width="6" height="1.7" rx="0.85" fill="currentColor" opacity="0.75" />
      <rect x="7.6" y="14.3" width="7.5" height="1.7" rx="0.85" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

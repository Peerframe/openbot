/**
 * The OpenBot app icon (AppIcon artboard; sources in docs/design/app-icon). It is the Round Bot on
 * a light tile; below 32px the micro drawing keeps the eyes and antenna legible. Decorative: the
 * surrounding text always names OpenBot.
 */
export function AppIcon({ size = 64, className = "" }: { size?: number; className?: string }) {
  const micro = size < 32;
  return (
    <svg
      className={`app-icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="2"
        y="2"
        width="1020"
        height="1020"
        rx="230"
        fill="#F5F5F2"
        stroke="#E3E3E6"
        strokeWidth={micro ? 32 : 4}
      />
      <g transform="translate(120 120) scale(8.166667)">
        <path
          d="m39 30-4-10"
          fill="none"
          stroke="#20251F"
          strokeWidth={micro ? 6 : 4}
          strokeLinecap="round"
        />
        <circle cx="33" cy="16" r={micro ? 5.6 : 4.3} fill="#20251F" />
        <path
          d="M12 61C12 41 27 26 47 26C68 26 83 41 83 61V71C83 83 69 89 48 89C26 89 12 83 12 71Z"
          fill="#20251F"
        />
        <path d="M12 69C29 76 66 76 83 69V72C83 83 69 89 48 89C26 89 12 83 12 72Z" fill="#91CF4B" />
        <g fill="#FAFBF7">
          {micro ? (
            <>
              <rect x="28" y="43" width="12" height="21" rx="6" />
              <rect x="54" y="43" width="12" height="21" rx="6" />
            </>
          ) : (
            <>
              <rect x="29" y="44" width="10" height="19" rx="5" />
              <rect x="55" y="43" width="10" height="19" rx="5" />
            </>
          )}
        </g>
      </g>
    </svg>
  );
}

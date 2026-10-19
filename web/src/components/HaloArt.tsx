/** Halo mark: a glowing orb (your whole balance sheet) inside a tilted protective ring (the agent). */
export function HaloLogo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="Halo">
      <defs>
        <radialGradient id="halo-orb" cx="38%" cy="32%" r="72%">
          <stop offset="0" stopColor="#fffbe8" />
          <stop offset="0.45" stopColor="#e3f56b" />
          <stop offset="1" stopColor="#c98a3a" />
        </radialGradient>
      </defs>
      {/* back half of the ring, behind the orb */}
      <path d="M3.2 21.7 A14 5.5 -24 0 1 28.8 10.3" fill="none" stroke="#fff" strokeWidth="1.8" opacity="0.45" strokeLinecap="round" />
      <circle cx="16" cy="16" r="7.2" fill="url(#halo-orb)" />
      <circle cx="13.6" cy="13.2" r="1.7" fill="#fff" opacity="0.6" />
      {/* front half of the ring, over the orb */}
      <path d="M3.2 21.7 A14 5.5 -24 0 0 28.8 10.3" fill="none" stroke="#fff" strokeWidth="1.9" strokeLinecap="round" />
      <circle cx="28.8" cy="10.3" r="1.7" fill="#e3f56b" />
    </svg>
  );
}

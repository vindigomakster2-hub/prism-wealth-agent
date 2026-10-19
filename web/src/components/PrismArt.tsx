export function PrismLogo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="Prism">
      <path d="M16 3 29 27H3z" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M16 3 19 27" stroke="#fff" strokeWidth="1.6" opacity="0.6" />
      <path d="M22 16 31 12M22.6 18 31 18M22 20 31 24" stroke="#e3f56b" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

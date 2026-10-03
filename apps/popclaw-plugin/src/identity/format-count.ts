/**
 * Compact follower count for human display. 0 / negative → '' (unknown,
 * caller omits the segment). The full-precision integer lives in the proto
 * for the popclaw agent; this is presentation only.
 *
 *   850 → "850"   8500 → "8.5k"   67000 → "67k"   1_300_000 → "1.3m"   1.3e9 → "1.3b"
 *
 * Rule: pick unit by magnitude (k/m/b); leading value <10 keeps 1 decimal,
 * else 0 decimals; trailing ".0" stripped; lowercase suffix. Rounding that
 * carries to >=1000 promotes to the next unit (999_999 → "1m").
 */
export function formatFollowerCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return String(n);
  const units: [number, string][] = [
    [1_000_000_000, 'b'],
    [1_000_000, 'm'],
    [1_000, 'k'],
  ];
  for (const [base, suffix] of units) {
    if (n >= base) {
      const v = n / base;
      const rounded = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
      // Carry: rounding bumped it to the next unit (e.g. 999_999 / 1000 = 999.999 → 1000).
      if (rounded >= 1000 && suffix !== 'b') {
        return formatFollowerCount(base * 1000);
      }
      const s = rounded < 10 ? rounded.toFixed(1).replace(/\.0$/, '') : String(rounded);
      return `${s}${suffix}`;
    }
  }
  return String(n);
}

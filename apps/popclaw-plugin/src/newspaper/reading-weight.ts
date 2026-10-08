/** OpenClaw 2026.9.8's CJK response estimate; pure and shared by pagination and diagnostics. */
const ranges: readonly (readonly [number, number, number])[] = [
  [183, 183, 4], [12288, 12703, 4], [19968, 40869, 4], [44032, 55215, 4], [65281, 65376, 4],
  [4352, 4607, 12], [11904, 12287, 12], [12704, 19967, 12], [40870, 40959, 12],
  [40960, 42239, 12], [42752, 42759, 12], [43360, 43391, 12], [55216, 55295, 12], [63744, 64255, 12],
  [711, 711, 8], [713, 715, 8], [729, 729, 8], [746, 747, 8], [773, 773, 8], [803, 803, 8],
  [65040, 65103, 8], [65377, 65500, 8], [65504, 65510, 8], [119648, 119665, 12],
  [94176, 94207, 16], [110576, 110591, 16], [110592, 110959, 16],
  [127488, 127743, 16], [131072, 195103, 16], [196608, 210047, 16],
];
export function weightedChars(text: string): number {
  let total = 0;
  for (const point of text) {
    const code = point.codePointAt(0)!;
    total += code < 128 ? 1 : (ranges.find(([start, end]) => code >= start && code <= end)?.[2] ?? point.length);
  }
  return total;
}

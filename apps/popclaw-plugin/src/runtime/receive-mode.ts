/** One receive configuration, captured before either mutable host is built. */
export type ReceiveMode = 'public-v1';
export function resolveReceiveMode(value: string | undefined = process.env['POPCLAW_WORLD_STREAM']): ReceiveMode {
  if (value === undefined || value === 'public-v1') return 'public-v1';
  throw new Error('RECEIVE_MODE_INVALID: POPCLAW_WORLD_STREAM must be unset or exactly public-v1. ' +
    'Legacy 1 and other explicit values are unsupported. Inspect the selected data root and use the offline upgrade/adoption path before normal startup.');
}

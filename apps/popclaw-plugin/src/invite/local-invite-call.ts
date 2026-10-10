/** Prepare and preview are local. The Native posted entry owns its guarded command. */
export function isLocalInviteCall(name: string, params: unknown): boolean {
  if (name !== 'popclaw_invite') return false;
  if (!params || typeof params !== 'object') return true;
  const p = params as Record<string, unknown>;
  return Object.keys(p).length !== 1 || typeof p.confirm_token !== 'string' || !p.confirm_token.trim();
}

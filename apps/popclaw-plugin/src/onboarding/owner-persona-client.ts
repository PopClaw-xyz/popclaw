/** The consumer distribution never reads a persona file or its path setting. */
export async function readOwnerPersonaFromEnv(
  _env?: Record<string, string | undefined>,
): Promise<string | undefined> {
  return undefined;
}

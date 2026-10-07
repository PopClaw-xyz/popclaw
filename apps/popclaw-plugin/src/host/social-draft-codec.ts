/** JSON contains manuscript data only, never callbacks or invocation authority. */
export function encodeSocialDraft(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item instanceof Uint8Array
    ? {socialDraftBytes: Buffer.from(item).toString('base64')} : item);
}
export function decodeSocialDraft<T>(value: string): T {
  return JSON.parse(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && Object.keys(item).length === 1
      && typeof (item as {socialDraftBytes?: unknown}).socialDraftBytes === 'string') {
      return new Uint8Array(Buffer.from((item as {socialDraftBytes: string}).socialDraftBytes, 'base64'));
    }
    return item;
  }) as T;
}

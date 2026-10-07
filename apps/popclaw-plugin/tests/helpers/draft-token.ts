export function draftToken(text: string): string | undefined {
  try { const data = JSON.parse(text); return typeof data.draft_id === 'string' ? data.draft_id : undefined; }
  catch { return [...text.matchAll(/^[ \t]*draft_id:\s*(\S+)$/gm)].at(-1)?.[1]; }
}

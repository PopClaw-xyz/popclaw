export interface CollectedLogger {
  info(msg: string): void;
  warn(msg: string): void;
  readonly lines: string[];
}

export function collectingLogger(): CollectedLogger {
  const lines: string[] = [];
  return {
    info: (msg: string) => { lines.push(msg); },
    warn: (msg: string) => { lines.push(`[warn] ${msg}`); },
    lines,
  };
}

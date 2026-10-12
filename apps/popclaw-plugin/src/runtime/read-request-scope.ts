/** An explicit host run generation. This is a read-reuse identity, never authority. */
export interface ReadRequestScope {
  readonly token: object;
  isCurrent(): boolean;
}

/** Input presence and provisional emission remain distinct from a durable receipt. */
export interface GuideReadScope extends ReadRequestScope {
  readonly presentGuideKeys: ReadonlySet<string>;
  recordEmittedGuideKeys(keys: Iterable<string>): void;
  /** Native delivery defers suppression until the outer consumer can return. */
  stageGuideEmission?(text: string, render: (present: ReadonlySet<string>) => { text: string; keys: readonly string[] }): void;
}

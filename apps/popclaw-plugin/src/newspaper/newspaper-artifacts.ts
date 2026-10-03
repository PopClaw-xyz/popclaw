/** The synchronous storage capability needed to publish and correct one local edition. */
export interface SavedNewspaperIssue {
  readonly path: string;
  /** Rewrite the selected archive first, then the latest copy; failures propagate. */
  rewrite(html: string): void;
}

export interface NewspaperIssueArchive {
  /** Save the edition and return its actual selected archive path and correction handle. */
  save(input: { token: string; html: string; nowMs: number }): SavedNewspaperIssue;
}

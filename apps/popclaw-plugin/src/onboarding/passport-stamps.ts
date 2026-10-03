/**
 * Passport presentation types (stamps + doors), shared by the onboarding
 * orchestrator and the briefing renderer. Formerly part of the canvas page
 * module; the types outlive it — the chat-card briefing still renders them.
 */
export interface PassportStamp {
  readonly houseName: string;
  readonly ok: boolean;
}

export interface PassportDoor {
  readonly houseName: string;
  readonly knowsYou: boolean;
  readonly blurb?: string;
  readonly headline?: string;
  readonly homeUrl?: string;
  readonly firstMove?: string;
}

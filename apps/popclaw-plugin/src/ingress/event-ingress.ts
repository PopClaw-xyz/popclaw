export interface InboundEnvelope {
  readonly eventId: string;
  /** Raw decoded EventEnvelope object from pbjs (camelCase fields). */
  readonly envelope: Record<string, unknown>;
}

export type EnvelopeHandler = (envelope: InboundEnvelope) => void | Promise<void>;

export interface EventIngress {
  start(onEnvelope: EnvelopeHandler): Promise<void>;
  stop(): Promise<void>;
  /**
   * Optional (#144): run `cb` after every (re)connect. Anything the far side
   * only replays in response to a request — a ranger's pinned watch
   * assignments, say — has to be re-asked for once the subscription is up,
   * because a stream is an at-most-once channel and a reconnect silently
   * drops whatever was in flight. Implementations without a connection to
   * speak of simply omit it, and callers fall back to asking once.
   */
  onConnected?(cb: () => void): void;
}

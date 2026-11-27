export interface SessionIdentity {
  sessionID: string;
  directory?: string;
}

export interface SessionUsage {
  sessionID: string;
  input: number;
  read: number;
  write: number;
  /** Generated tokens; zero when the host does not report them. */
  output: number;
  reasoning: number;
  /**
   * The message this receipt belongs to. Streaming updates overwrite each other;
   * they must not overwrite another message's receipt.
   */
  messageID?: string;
  /**
   * A cumulative receipt replaces the session total instead of adding to it.
   */
  cumulative?: boolean;
}

/** Call direction wired at session start (browser ?mode= or CALL_MODE default). Used to gate prompt text. */
export type VoiceCallMode = "inbound" | "outbound";

export type VoiceInstructionProvider = "openai" | "grok" | "gemini";

/** Identifies how instructions are routed at session create (different stacks need different coaxing). */
export type VoiceInstructionContext = {
  provider: VoiceInstructionProvider;
  /** Provider model id as wired for this session (e.g. gpt-realtime-2, grok-voice-think-fast-1.0). */
  model: string;
};

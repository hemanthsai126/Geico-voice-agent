import { intakeAgentCore } from "./intakeCore.js";
import { geminiLiveStackAddendum } from "./geminiLive.js";
import { grokVoiceStackAddendum } from "./grokVoice.js";
import { openaiRealtimeStackAddendum } from "./openaiRealtime.js";
import type { VoiceCallMode, VoiceInstructionContext } from "./types.js";

function stackAddendum(context: VoiceInstructionContext): string {
  switch (context.provider) {
    case "openai":
      return openaiRealtimeStackAddendum(context.model);
    case "grok":
      return grokVoiceStackAddendum(context.model);
    case "gemini":
      return geminiLiveStackAddendum(context.model);
    default: {
      const _exhaustive: never = context.provider;
      return _exhaustive;
    }
  }
}

export function buildRealtimeIntakeInstructions(mode: VoiceCallMode, context: VoiceInstructionContext): string {
  return intakeAgentCore(mode) + stackAddendum(context);
}

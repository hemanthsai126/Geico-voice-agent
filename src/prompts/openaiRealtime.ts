/** Voice-stack addendum appended after `intakeCore` for OpenAI Realtime sessions. */

function wrap(block: string): string {
  return `\n${block}\n`;
}

export function openaiRealtimeStackAddendum(modelId: string): string {
  const modelNorm = modelId.trim().toLowerCase();

  if (!modelNorm.includes("gpt-realtime-2")) {
    return wrap(`# Voice stack: OpenAI Realtime (${modelId})

- This model is OpenAI Realtime but not GPT Realtime 2. Keep turns slightly shorter than in the template if latency spikes; stick to one tool call intent per conversational beat when ambiguity appears.
- Do not verbalize premiums, quotes, or “saved until” states until generate_quote / save_confirmed_intake succeeds in the transcript.`);
  }

  return wrap(`# Voice stack: OpenAI GPT Realtime 2 (${modelId})

- This session expects GPT Realtime 2 pacing: follow the scripted sections verbatim. Server turn detection manages back-and-forth; avoid doubling questions while the caller is finishing a dense string (phones, DL, email, VIN).
- Preserve long-context discipline in # Conversation memory across the call—it matches this model family’s behavior.`);
}

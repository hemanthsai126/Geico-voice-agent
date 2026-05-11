/** Voice-stack addendum for xAI Grok Voice (browser session proxied via `providerRealtime`). */

function wrap(block: string): string {
  return `\n${block}\n`;
}

export function grokVoiceStackAddendum(modelId: string): string {
  return wrap(`# Voice stack: Grok Voice (${modelId})

- Session uses Grok realtime voice over PCM at the negotiated sample rates. Keep answers concise while collecting dense strings (phones, DL, email, VIN); confirm digit-heavy values once.
- Follow the scripted sections; use one explicit tool invocation per conversational beat when the next step depends on tool output.
- Never verbalize saved quote or intake state until the corresponding tool succeeds in the transcript.`);
}

/** Voice-stack addendum for Gemini Live (BidiGenerateContent, proxied via `providerRealtime`). */

function wrap(block: string): string {
  return `\n${block}\n`;
}

export function geminiLiveStackAddendum(modelId: string): string {
  return wrap(`# Voice stack: Gemini Live (${modelId})

- Prefer short spoken turns; pause briefly after dense strings (VINs, numbers) so captions stay usable.
- Session state updates only via tools—a verbal recap does **not** count as captured fields, a quote you say aloud is invalid until generate_quote succeeds, and the intake is not saved until save_confirmed_intake succeeds.
- Use declared function tools exactly as specified with valid JSON arguments. For parameterless tools, call them with {} or leave optional args unset; once every personal and vehicle field is present in tools, call generate_quote without delay, then checkout and save per the scripted flow.
- Translate non-English speech per # Language rules; tool payloads and summaries remain in English as required.`);
}

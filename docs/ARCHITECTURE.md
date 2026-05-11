# Voice Agent Architecture

## Current Runtime

The browser microphone flow is the primary local test path.

1. `public/call.html` loads `public/app.js`.
2. `public/app.js` requests session config from `/api/realtime/token` (provider + model from the picker).
3. **OpenAI:** `src/browserRealtime.ts` mints a Realtime client secret for `OPENAI_REALTIME_MODEL`; the browser completes WebRTC to OpenAI.
4. **Grok / Gemini:** the same handler returns instructions, tools, PCM rates, and a path to `/api/provider-realtime`; `src/providerRealtime.ts` proxies the browser WebSocket to xAI or Gemini Live while keeping API keys on the server.
5. Realtime tool calls are executed in `public/app.js`.
6. Backend APIs handle VIN decoding, GEICO RAG search, Firebase save, and observability storage.

## Main Boundaries

- `src/prompts/`: Lizzy's voice-agent prompt—shared core in `intakeCore.ts`; provider-specific addenda in `openaiRealtime.ts`, `grokVoice.ts`, `geminiLive.ts`; wired in `buildRealtimeIntake.ts`.
- `src/browserRealtime.ts`: session bootstrap for OpenAI (client secrets) and for Grok/Gemini (instructions + tools over the provider proxy).
- `src/providerRealtime.ts`: WebSocket upgrade at `/api/provider-realtime` proxying to xAI or Gemini with server-side keys.
- `public/app.js`: WebRTC client, tool execution, transcript capture, audio recording, and browser-side eval timing.
- `src/geicoKnowledge.ts`: cleaned GEICO data loading, semantic embedding index, and retrieval.
- `src/intake.ts`: intake validation, normalization, summaries, and confirmation rules.
- `src/firebase.ts`: confirmed lead persistence.
- `src/observability.ts`: local conversation, transcript, tool-call, eval, and audio persistence.
- `public/evals.js`, `public/eval-conversation.js`, `public/evalMetrics.js`: overall and per-conversation dashboards.

## Voice Model Provider Direction

Three stacks are wired in the demo UI: **OpenAI Realtime** (WebRTC), **Grok Voice** (xAI realtime via proxy), **Gemini Live** (bidirectional Gemini via proxy). Environment variables:

```text
VOICE_MODEL_PROVIDER=openai
OPENAI_REALTIME_MODEL=gpt-realtime-2
GROK_API_KEY=
GROK_VOICE_MODEL=grok-voice-think-fast-1.0
GEMINI_API_KEY=
GEMINI_VOICE_MODEL=gemini-3.1-flash-live-preview
```

Chosen defaults:

- GPT Realtime 2 (`gpt-realtime-2`) for OpenAI as the primary tested Lizzy realtime stack.
- `grok-voice-think-fast-1.0` for Grok (xAI voice realtime).
- `gemini-3.1-flash-live-preview` for Gemini Live low-latency voice.

The clean next step is to consolidate provider branching behind a narrower adapter boundary in the browser layer.

Suggested shape:

```text
src/voiceProviders/
  index.ts
  openaiRealtime.ts
  grokVoice.ts
  geminiLive.ts
```

Each provider should expose the same small interface:

```ts
type VoiceProviderSession = {
  provider: "openai" | "grok" | "gemini";
  model: string;
  clientSecret?: string;
  websocketUrl?: string;
  sessionConfig: unknown;
};
```

The browser and eval dashboards should record `provider`, `model`, `promptVersion`, and `evalRunId` on every conversation. That lets `/evals` compare prompt updates and model switches without mixing unrelated runs.

The call page now includes a **Voice model for this conversation** selector. The backend exposes configured model choices at `/api/realtime/models`, and the browser passes the selected `provider` and `model` to `/api/realtime/token`. Saved conversation records include:

```json
{
  "voiceModel": {
    "provider": "openai",
    "model": "gpt-realtime-2"
  }
}
```

OpenAI uses the native browser WebRTC path. Grok and Gemini use the local provider realtime WebSocket proxy at `/api/provider-realtime`, which keeps provider API keys on the backend while the browser streams PCM audio and receives provider audio back.

Provider adapter notes:

- OpenAI: WebRTC session through `/api/realtime/token` and `https://api.openai.com/v1/realtime/calls`.
- Grok: local WebSocket proxy to `wss://api.x.ai/v1/realtime`, using `GROK_API_KEY` on the backend.
- Gemini: local WebSocket proxy to Gemini Live `BidiGenerateContent`, using `GEMINI_API_KEY` on the backend.
- Browser-side PCM streaming is used for Grok/Gemini; OpenAI keeps the existing WebRTC media path.

Provider-specific eval pages reuse the same dashboard and filter by `voiceModel.provider`:

```text
/evals/openai
/evals/grok
/evals/gemini
```

## Eval Run Tracking Direction

Current evals are computed from saved conversations. For multi-run comparisons, add an explicit eval-run record:

```ts
type EvalRun = {
  id: string;
  name: string;
  createdAt: string;
  provider: string;
  model: string;
  promptVersion: string;
  notes?: string;
};
```

Each conversation should store `evalRunId`. The dashboard can then compare:

- run vs run latency
- corrections per run
- tool failures per run
- RAG score averages per run
- model/provider changes
- prompt changes

This avoids inferring comparisons from dates or customer names.

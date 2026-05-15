# Deploying on Vercel

This repo can run **HTTP routes + static files** on Vercel via `api/index.ts` and `vercel.json`. **WebSocket upgrades are not supported** on standard Vercel serverless functions, so anything that relied on:

- `/api/provider-realtime` (Grok / Gemini browser proxy), or  
- `/twilio/media-stream` (Twilio Media Streams)

needs either **another host** for those sockets or **environment overrides** below.

## Quick setup

1. Push this repo to GitHub and **Import** it in the [Vercel dashboard](https://vercel.com).
2. Set **Root Directory** to the repo root (default).
3. Vercel will use `vercel.json`: install deps, run `npm run build`, deploy `api/index.ts` behind a rewrite that forwards the original path via `__p=` (Express middleware in `src/vercelPath.ts` restores it). Do not change that rewrite to a bare `/api` destination or links such as `/inbound` will 404.

## Required environment variables

Same as local production (see `.env.example`), including:

- `OPENAI_API_KEY`
- `FIREBASE_PROJECT_ID`, Firestore auth vars (`FIREBASE_PRIVATE_KEY`, etc.)

**Public URL:** If you omit `PUBLIC_BASE_URL`, production builds infer `https://${VERCEL_URL}` when `VERCEL_URL` is set.

## Grok / Gemini on Vercel

Browser flows use a WebSocket to `/api/provider-realtime`. That **cannot** terminate on Vercel’s serverless runtime.

**Option A — OpenAI only on Vercel**  
Leave `PROVIDER_REALTIME_WS_ORIGIN` unset. Grok/Gemini are marked unavailable until you add a relay.

**Option B — Relay (recommended if you need Grok/Gemini)**  
Deploy **the same codebase** on Railway/Render/Fly (full `npm run build && npm run start` — **not** `VERCEL=1`). That process exposes WebSockets.

Then on Vercel set:

```bash
PROVIDER_REALTIME_WS_ORIGIN=https://your-ws-host.example.com
```

Tokens will return an **absolute** `wss://…` URL so the browser connects to the relay while the UI stays on Vercel.

## Twilio inbound + Media Streams

`<Connect><Stream>` must point at a **`wss:`** endpoint that accepts Twilio’s socket. That is **not** Vercel serverless.

Point streams at your WS-capable deployment:

```bash
TWILIO_MEDIA_STREAM_WS_URL=wss://your-ws-host.example.com/twilio/media-stream
```

Keep `PUBLIC_BASE_URL` as your **Vercel** URL for HTTP webhooks (`/twilio/voice`) if that handler stays on Vercel.

## Limits

- Function **`maxDuration`** is set to 60s in `vercel.json`; adjust if needed (plan-dependent).
- Large **`conversation audio`** uploads may hit body-size limits on Hobby — monitor 413 responses.

## Local development

Unchanged:

```bash
npm run dev
```

Uses `src/server.ts` with WebSockets enabled (`VERCEL` is unset).

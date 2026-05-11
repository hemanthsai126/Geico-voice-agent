# Lizzy GEICO Quote Agent

Mock GEICO vehicle-insurance quote agent using OpenAI Realtime, Firebase Firestore, browser microphone testing, and optional Twilio Voice Media Streams.

Lizzy from GEICO collects first name, last name, age, address, email, 10-digit phone number, driver license number, and 17-character VIN. The app keeps the VIN, decodes it to year, make, model, and trim, asks only for decoded vehicle fields that are still missing, answers GEICO auto-insurance questions with semantic RAG over `Geico Data`, generates a mock quote only after all details are complete, collects mock payment details in memory only, reads the full summary back, and writes non-payment data to Firestore only after explicit confirmation. Lizzy always starts in English, can continue in the customer's language if they switch, and still writes all stored fields/results in English.

For a detailed explanation of the full project, see [`docs/PROJECT_GUIDE.md`](docs/PROJECT_GUIDE.md).

## Setup

```bash
npm install
cp .env.example .env
```

**GitHub:** Do not commit `.env`. It is gitignored (along with `Observability/` recordings and Firebase key patterns). Copy only from `.env.example`, keep real keys locally, and use `git status` before every push to confirm nothing sensitive is staged.

Fill in `.env` with:

- `OPENAI_API_KEY`
- `PUBLIC_BASE_URL`, required for Twilio phone calls; browser microphone testing can use the default/local value
- `FIREBASE_PROJECT_ID`
- Firebase credentials, either via `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` or Application Default Credentials

## Local Development

Start the backend:

```bash
npm run dev
```

Open the local app:

```text
http://localhost:3000
```

Choose one of the two local pages:

```text
http://localhost:3000/inbound
http://localhost:3000/outbound
```

The only difference is the opening. Inbound starts as if the customer called GEICO. Outbound starts as if Lizzy from GEICO called the customer. After that, both flows use the same quote logic.

Review saved conversations:

```text
http://localhost:3000/conversations
```

Each stopped conversation saves exact Realtime transcript events, tool calls, metadata, and one mixed `conversation.webm` audio file under `Observability/conversations`. Transcript rows use `Lizzy` and the customer's first name once captured, and the conversation page also shows a full transcript. Audio recording pauses during payment collection and resumes after the mock transaction succeeds, so card audio is not stored.

Review conversation evals:

```text
http://localhost:3000/evals
```

The eval dashboard has an overall metrics page with graphs plus per-conversation drilldowns. It summarizes response latency, tool-call duration, corrections, overwrites, interruptions, silent failures, save timing, and RAG quality metrics from saved conversations.

## GEICO Semantic RAG

GEICO answer retrieval uses OpenAI embeddings over the cleaned files in `Geico Data/pages`. The first question builds `Geico Data/semantic-index.json` with `text-embedding-3-small`; later questions reuse that local cache until the cleaned source files change.

Tests use a keyword fallback so they do not call OpenAI.

## Phone Call Testing

Expose it to Twilio:

```bash
ngrok http 3000
```

Set your Twilio phone number voice webhook to:

```text
POST https://your-ngrok-domain.ngrok-free.app/twilio/voice
```

The TwiML response opens a bidirectional stream to:

```text
wss://your-ngrok-domain.ngrok-free.app/twilio/media-stream
```

## Firebase

Confirmed records are saved to the Firestore collection in `FIRESTORE_COLLECTION`, defaulting to `voiceIntakeLeads`.

Only confirmed records are stored in Firestore. Mock payment card number, expiration month/year, and CVV live in runtime memory only and are never saved to Firebase.

## Scripts

```bash
npm run dev
npm run typecheck
npm test
npm run build
npm start
```

## Deployment

Deploy the backend to Cloud Run or another host that supports long-lived WebSocket connections. Use Secret Manager or equivalent environment secret storage for OpenAI, Firebase, and Twilio-related configuration.

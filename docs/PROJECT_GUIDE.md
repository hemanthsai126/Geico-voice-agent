# Lizzy GEICO Quote Agent Project Guide

## Overview

This project is a realtime mock GEICO vehicle-insurance quote agent. Lizzy from GEICO speaks with a customer through the browser microphone, collects required personal and vehicle information, answers GEICO auto-insurance questions with semantic RAG over the cleaned `Geico Data` pages, generates a mock quote, confirms the captured details, and saves the confirmed record to Firebase Firestore. Lizzy always opens in English, can continue in the customer's language if they respond in another language, and stores all fields/results in English.

Local testing uses the browser microphone pages:

```text
http://localhost:3000/inbound
http://localhost:3000/outbound
```

There are two local call pages:

- **Inbound call**: the customer called GEICO.
- **Outbound call**: Lizzy from GEICO called the customer.

Only the opening changes. The collection, GEICO auto-insurance Q&A, VIN decoding, quote generation, confirmation, and save logic are shared.

## What The Agent Collects

The agent collects these required fields:

- First name
- Last name
- Age
- Address
- Email address
- 10-digit phone number
- Driver license number
- VIN number, exactly 17 valid VIN characters

After the VIN is captured, the backend keeps the VIN and decodes:

- VIN
- Year
- Make
- Model
- Trim

The agent reads the decoded vehicle details back to the user for clarification. If the VIN API does not return year, make, model, or trim, Lizzy asks only for the missing vehicle detail and does not re-ask details that were already decoded.

After all required personal and vehicle details are collected, the app generates a random mock quote. The quote is a local demo estimate, not a real insurance price. Premium, coverage, and term are not known or spoken before this step.

After the mock quote is read, Lizzy asks for mock payment details: card number, expiration month, expiration year, and CVV. These payment details are held only in runtime memory for the local mock flow and are never saved to Firebase.

## Conversation Behavior

The agent asks for one missing field at a time.

For names and email addresses, it does not ask the user to spell upfront. Instead, it captures what the user says, spells back what it captured, and asks if anything needs to be changed.

For phone numbers, the app requires exactly 10 digits. Formatting such as spaces, dashes, parentheses, and dots is removed before validation. For example:

```text
(555) 123-4567 -> 5551234567
```

For driver license number and VIN, the agent repeats the captured value back and asks if anything needs to be changed.

The agent saves only after the user explicitly confirms the final summary. The summary can mention masked payment status, such as card ending in the last four digits, but must not repeat the full card number or CVV.

If the user asks questions, Lizzy answers only about GEICO auto insurance and vehicle insurance. She uses semantic RAG over the cleaned `Geico Data/pages` files before answering coverage, discount, deductible, state requirement, roadside, rental, collision, comprehensive, liability, medical payments, PIP, uninsured motorist, or related questions. If the customer asks about unrelated topics, Lizzy politely redirects back to vehicle insurance. Spoken answers can follow the customer's current language, but tool calls and stored values remain in English.

## Browser Microphone Flow

The browser microphone flow works like this:

1. The user opens `http://localhost:3000`.
2. The user chooses **Inbound call** or **Outbound call**.
3. The user clicks **Start microphone test**.
4. The browser asks for microphone permission.
5. The backend creates a short-lived OpenAI Realtime client secret with the selected call mode.
6. The browser connects to OpenAI Realtime with WebRTC.
7. The user speaks with Lizzy.
8. The model calls tools when it captures fields or needs GEICO auto-insurance knowledge.
9. The browser updates the visible collected fields.
10. When VIN is captured, the backend decodes the VIN using NHTSA VPIC.
11. The decoded VIN, year, make, model, and trim appear in the UI.
12. If any vehicle field is missing from the VIN API, Lizzy asks only for that missing detail.
13. The app generates a mock quote after all required personal and vehicle details are captured.
14. Lizzy collects mock payment details in memory only.
15. After the user confirms the summary, the browser asks the backend to save the record.
16. The backend saves the confirmed intake to Firebase Firestore without payment details.
17. When the user presses **Stop**, the browser saves local observability data.

## Main Files

### Backend

- `src/server.ts` starts the Express server, serves the browser UI, and exposes API routes.
- `src/observability.ts` stores local conversation metadata, transcript events, tool calls, and audio files.
- `src/browserRealtime.ts` creates OpenAI Realtime browser tokens, saves browser intake records, exposes VIN decoding, and exposes GEICO semantic RAG search.
- `src/geicoKnowledge.ts` chunks cleaned GEICO auto-insurance data from `Geico Data/pages`, builds a local OpenAI embedding cache, and retrieves semantically relevant snippets.
- `src/intake.ts` defines the intake fields, validation, normalization, confirmation state, and summary formatting.
- `src/firebase.ts` initializes Firebase Admin and writes confirmed records to Firestore.
- `src/vinDecoder.ts` decodes VINs through the NHTSA VPIC API and returns only year, make, model, and trim.
- `src/prompts/`: Lizzy’s shared intake prompt (`intakeCore.ts`) plus provider stack addenda (`openaiRealtime.ts`, `grokVoice.ts`, `geminiLive.ts`; composed in `buildRealtimeIntake.ts`).

### Browser UI

- `public/index.html` is the local landing page for choosing inbound or outbound.
- `public/call.html` is the shared browser microphone call page.
- `public/conversations.html` and `public/conversations.js` provide the local conversation review page.
- `public/evals.html`, `public/evals.js`, `public/eval-conversation.html`, `public/eval-conversation.js`, and `public/evalMetrics.js` provide the overall and per-conversation evaluation dashboards.
- `public/app.js` handles WebRTC, microphone access, Realtime events, tool calls, VIN decoding, and save requests.
- `public/styles.css` styles the local test page.

### Tests

- `tests/intake.test.ts` covers field validation, confirmation gating, driver license collection, phone validation, and vehicle attachment.
- `tests/firebase.test.ts` covers Firestore record payload creation.
- `tests/vinDecoder.test.ts` covers vehicle detail formatting.

## Environment Variables

Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

Required values:

```text
OPENAI_API_KEY=your_openai_api_key
OPENAI_REALTIME_MODEL=gpt-realtime-2
VOICE_MODEL_PROVIDER=openai
GROK_VOICE_MODEL=grok-voice-think-fast-1.0
GEMINI_VOICE_MODEL=gemini-3.1-flash-live-preview
FIREBASE_PROJECT_ID=your_firebase_project_id
FIRESTORE_COLLECTION=voiceIntakeLeads
```

Optional future model-provider keys:

```text
GROK_API_KEY=your_grok_api_key
GEMINI_API_KEY=your_gemini_api_key
```

Put real keys only in your local `.env` file. Do not paste real keys into chat, docs, Git, or `.env.example`. The current browser voice flow is still wired to OpenAI Realtime; the Grok and Gemini model names are ready for the model-provider adapter work.

For Firebase Admin local credentials, also set:

```text
FIREBASE_CLIENT_EMAIL=your_firebase_service_account_email
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

## How To Run Locally

Install dependencies:

```bash
npm install
```

Start the backend:

```bash
npm run dev
```

Open the browser app and choose a call type:

```text
http://localhost:3000
http://localhost:3000/inbound
http://localhost:3000/outbound
```

Click **Start microphone test**, allow microphone access, and complete the conversation.

Before starting, choose **Voice model for this conversation** on the call page. The selected provider and model are stored with the saved conversation and shown in Conversations/Evals as friendly names when available (OpenAI GPT Realtime 2 uses model id `gpt-realtime-2` and the existing WebRTC path). Grok and Gemini use the local provider realtime WebSocket proxy, so their API keys stay on the backend while the browser streams PCM audio.

Review saved conversations:

```text
http://localhost:3000/conversations
```

## How To Know It Worked

During the call, the page should show:

- Captured personal fields
- Captured driver license number
- Captured VIN
- VIN plus decoded vehicle year, make, model, and trim
- Mock quote
- Local observability entry after pressing **Stop**
- Event log messages

After final confirmation, the log should show a saved record ID:

```text
Saved confirmed intake: <firestore-document-id>
```

In Firebase Firestore, check the collection:

```text
voiceIntakeLeads
```

## Saved Firestore Record Shape

A confirmed record includes:

```ts
{
  firstName: string;
  lastName: string;
  age: number;
  address: string;
  email: string;
  phoneNumber: string;
  driverLicenseNumber: string;
  vin: string;
  vehicle: {
    vin: string;
    year: string;
    make: string;
    model: string;
    trim: string;
  };
  quote: {
    monthlyPremium: number;
    termMonths: number;
    coverageSummary: string;
  };
  status: "confirmed";
  voiceSessionId: string;
  createdAt: FirebaseFirestore.FieldValue;
  updatedAt: FirebaseFirestore.FieldValue;
}
```

For browser sessions, `voiceSessionId` uses a `browser-` prefixed id.

Payment details are intentionally not part of this saved record.

## Conversation Observability

The local observability page is available at:

```text
http://localhost:3000/conversations
```

Each stopped browser conversation is saved under:

```text
Observability/conversations/<conversation-id>/
```

Each conversation folder can contain:

- `conversation.json`: metadata, transcript entries, tool calls, and final non-payment state
- `conversation.webm`: mixed user and agent audio for the conversation

Transcript entries are saved from completed Realtime audio transcript events for the recorded audio, not generated summaries. Each entry is labeled as `Lizzy` or the customer's first name once collected. On the `/conversations` page, clicking a transcript row starts the conversation audio near that timestamp, and the detail view also shows the full transcript as plain text.

The local eval dashboard is available at:

```text
http://localhost:3000/evals
```

Provider-specific eval dashboards are also available:

```text
http://localhost:3000/evals/openai
http://localhost:3000/evals/grok
http://localhost:3000/evals/gemini
```

A dedicated retrieval analytics dashboard is available for aggregate RAG tooling:

```text
http://localhost:3000/rag-analysis
http://localhost:3000/rag-analysis/openai
http://localhost:3000/rag-analysis/grok
http://localhost:3000/rag-analysis/gemini
```

It lists how often each GEICO page pathname contributes snippets (bar chart plus a handful of rollup metrics).

The provider-specific eval and `/rag-analysis/...` URLs use the saved conversation `voiceModel.provider` field, so OpenAI, Grok, and Gemini recordings can be compared without mixing stacks.

The eval area has an overall metrics page, provider-specific pages, and a per-conversation drilldown page. These read the saved `conversation.json` files and display:

- user turn to Lizzy first-audio latency
- user turn to Lizzy final-transcript latency
- tool-call duration
- RAG latency and score quality
- Firebase save duration
- total call duration and time to save
- correction, re-ask, interruption, and silent-failure counts
- RAG duplicate result count, source diversity, low-confidence count, and citation traceability

Some metrics are best-effort browser-side measurements. For example, interruption detection is based on whether user transcription completes while agent audio is active, and corrections are counted when `update_collected_field` replaces an already captured non-empty field with a different value.

Payment safety behavior:

- Lizzy is instructed to call `begin_payment_collection` before asking for card details.
- Browser audio recording pauses when payment collection begins.
- The mock payment transaction always returns `success` after all payment fields are collected.
- Browser audio recording resumes after the success status is returned.
- Payment collection transcript is omitted because payment audio is not recorded.
- Payment values are redacted from tool-call logs where possible.
- Payment details are not saved to Firebase.

## Semantic RAG Process

Lizzy answers GEICO auto-insurance questions through a local semantic RAG pipeline. This is not web search. It only uses the cleaned text files in:

```text
Geico Data/pages/
```

The implementation lives in:

```text
src/geicoKnowledge.ts
```

The process is:

1. The app reads each cleaned GEICO `.txt` file.
2. It extracts the page title, source URL, and body text.
3. It splits the body into text blocks using blank lines.
4. It tries to detect short heading-like blocks.
5. It groups each heading with the text that follows it into a section.
6. If a section is longer than about 1,600 characters, it is split into overlapping chunks.
7. Each chunk is embedded with OpenAI `text-embedding-3-small`.
8. The generated embedding cache is saved to:

```text
Geico Data/semantic-index.json
```

That generated index is ignored by git. If the cleaned source files change, the source hash changes and the semantic index is rebuilt.

When the customer asks an insurance question:

1. Lizzy calls `search_auto_insurance_knowledge`.
2. The backend embeds the query.
3. The backend compares the query embedding to every chunk embedding using cosine similarity.
4. The top matching chunks are returned to Lizzy.
5. Lizzy answers from those returned chunks only.

The `score` shown in the conversation tool-call output is cosine similarity. Higher means the returned chunk is semantically closer to the query. It is not a keyword count.

### What Is A Chunk?

A chunk is not usually one line. It is usually a section of nearby text from a cleaned GEICO page, such as a FAQ answer or a group of paragraphs under a heading.

For example, in `16-www-geico-com-coverage-calculator.txt`, this text:

```text
What information do I need to shop for auto insurance?

Having the right information in hand can make it easier to get an accurate car insurance quote. You'll want to have:

Your driver's license number
Your vehicle's make and model
Your vehicle identification number (VIN)
The physical address where your vehicle will be stored
```

should be understood as one nearby information area, not four separate facts in isolation.

Current caveat: the heading detector is simple. Short standalone lines can sometimes look like headings, especially list-style lines such as:

```text
Your driver's license number
Your vehicle's make and model
Your vehicle identification number (VIN)
```

When that happens, the UI may show one of those lines as the `heading` label even though the embedded chunk is larger than that one line. The chunk still contains nearby source text; the label can just be misleading.

For debugging, the conversation page shows each RAG tool call with:

- input query
- returned title
- heading label
- cosine similarity score
- source URL
- snippet returned to Lizzy

If more precision is needed, the next improvement is to include `chunkId`, `fileName`, and expandable full chunk text in the tool-call output.

## VIN Decoding

VIN decoding uses the public NHTSA VPIC endpoint:

```text
https://vpic.nhtsa.dot.gov/api/
```

No API key is required for VIN decoding.

The app intentionally stores only:

- VIN
- Year
- Make
- Model
- Trim

Other decoded vehicle data is ignored.

## Validation Rules

Current validation rules:

- First name: required text
- Last name: required text
- Age: integer from 16 to 120
- Address: required text
- Email: valid email, lowercased before saving
- Phone number: exactly 10 digits after removing formatting
- Driver license number: required text, uppercased before saving
- VIN: 17 characters, uppercased, excluding invalid VIN letters `I`, `O`, and `Q`

Driver license formats vary by state, so the app does not enforce a specific license pattern yet.

## Important Notes

- Restart `npm run dev` after changing `.env` or agent instructions.
- Do not expose your real OpenAI or Firebase credentials in the browser.
- The browser receives only a short-lived OpenAI Realtime client secret.
- Firebase writes happen through the backend using Firebase Admin.
- Records are saved only after explicit user confirmation.

## Useful Commands

```bash
npm run dev
npm run typecheck
npm test
npm run build
npm start
```

import { displayVoiceModel } from "./evalMetrics.js";

const fields = ["firstName", "lastName", "age", "address", "email", "phoneNumber", "driverLicenseNumber", "vin"];
const vehicleFields = ["year", "make", "model", "trim"];
const paymentFields = ["cardNumber", "expirationMonth", "expirationYear", "cvv"];
const labels = {
  firstName: "First name",
  lastName: "Last name",
  age: "Age",
  address: "Address",
  email: "Email",
  phoneNumber: "Phone number",
  driverLicenseNumber: "Driver license number",
  vin: "VIN",
};

const startButton = document.querySelector("#startButton");
const stopButton = document.querySelector("#stopButton");
const statusEl = document.querySelector("#status");
const fieldsEl = document.querySelector("#fields");
const vehicleEl = document.querySelector("#vehicle");
const quoteEl = document.querySelector("#quote");
const paymentEl = document.querySelector("#payment");
const logEl = document.querySelector("#log");
const modeLabel = document.querySelector("#modeLabel");
const pageTitle = document.querySelector("#pageTitle");
const pageDescription = document.querySelector("#pageDescription");
const voiceModelSelect = document.querySelector("#voiceModelSelect");
const voiceModelNote = document.querySelector("#voiceModelNote");
const callMode = window.location.pathname.includes("outbound") ? "outbound" : "inbound";
const fallbackVoiceModel = {
  provider: "openai",
  model: "gpt-realtime-2",
  label: "OpenAI · GPT Realtime 2",
  available: true,
};

let peerConnection;
let dataChannel;
let providerSocket;
let mediaStream;
let remoteAudio;
let providerInputContext;
let providerOutputContext;
let providerInputSource;
let providerProcessor;
let providerOutputCursor = 0;
let providerPendingInputRate = 24000;
let providerBargeInActive = false;
const providerOutputSources = new Set();
/** Grok/Gemini: mix agent audio into recording using the same playback graph (avoids cross-`AudioContext` timing bugs). */
let providerAgentCaptureDestination;
let providerAgentCaptureIntoMix;
let currentVoiceProvider = "openai";
let draft = {};

let conversation;
let audioContext;
let mixedAudioDestination;
let mixedAudioRecorder;
let mixedAudioChunks = [];
let isFinalizingConversation = false;
let isPaymentCollectionActive = false;
let audioPausedAtMs;
let totalAudioPausedMs = 0;
const agentTranscriptDeltas = new Map();
const handledToolCallIds = new Set();
const providerFunctionNames = new Map();
const oneTimeLogs = new Set();
let pendingUserTurn;
let agentAudioActive = false;
let agentResponseStartedAtMs;
/** OpenAI RTC: truncate assistant transcripts to audio the user heard (see speech_started handler). */
let recentAssistantAudioItemId;
/** Grok/Gemini PCM playback: `{ startAt,endAt }` in providerOutputContext time (seconds) for proportional transcript trim on barge-in. */
let agentTurnPlaybackSlices = [];
const suppressedAgentTranscriptCommitKeys = new Set();

configurePage();
loadVoiceModelOptions();
renderFields();
renderVehicle();
renderQuote();
renderPayment();

startButton.addEventListener("click", startSession);
stopButton.addEventListener("click", stopSession);

async function startSession() {
  try {
    setStatus("Requesting microphone access...");
    startButton.disabled = true;

    const selectedVoiceModel = getSelectedVoiceModel();
    const tokenUrl = new URL("/api/realtime/token", window.location.origin);
    tokenUrl.searchParams.set("mode", callMode);
    tokenUrl.searchParams.set("provider", selectedVoiceModel.provider);
    tokenUrl.searchParams.set("model", selectedVoiceModel.model);

    const tokenResponse = await fetch(tokenUrl);
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(tokenData.error ?? "Could not create a realtime token.");
    }

    const ephemeralKey = tokenData?.value ?? tokenData?.client_secret?.value;
    if (selectedVoiceModel.provider !== "openai") {
      await startProviderSession(tokenData, selectedVoiceModel);
      return;
    }

    if (!ephemeralKey) {
      throw new Error("Realtime token response did not include a client secret value.");
    }

    beginConversation({
      provider: "openai",
      model: tokenData.model ?? selectedVoiceModel.model,
    });
    currentVoiceProvider = "openai";
    peerConnection = new RTCPeerConnection();
    remoteAudio = document.createElement("audio");
    remoteAudio.autoplay = true;

    peerConnection.ontrack = (event) => {
      remoteAudio.srcObject = event.streams[0];
      addAgentAudioToConversationRecording(event.streams[0]);
    };

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startConversationAudioRecording(mediaStream);
    peerConnection.addTrack(mediaStream.getAudioTracks()[0]);

    dataChannel = peerConnection.createDataChannel("oai-events");
    dataChannel.addEventListener("open", () => {
      log("Connected. Speak naturally to the agent.");
      setStatus("Connected. Speak into your microphone.");
      sendResponseCreate(openingInstruction());
    });
    dataChannel.addEventListener("message", handleRealtimeEvent);

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${ephemeralKey}`,
        "Content-Type": "application/sdp",
      },
    });

    if (!sdpResponse.ok) {
      throw new Error(await sdpResponse.text());
    }

    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: await sdpResponse.text(),
    });

    stopButton.disabled = false;
    voiceModelSelect.disabled = true;
  } catch (error) {
    log(`Error: ${error.message}`);
    setStatus("Failed to start. Check the log.");
    startButton.disabled = false;
    voiceModelSelect.disabled = false;
    stopSession();
  }
}

async function startProviderSession(tokenData, selectedVoiceModel) {
  if (!tokenData.websocketPath) {
    throw new Error(`${selectedVoiceModel.provider} did not return a realtime WebSocket path.`);
  }

  const inputRate = Number(tokenData.audio?.inputRate ?? 24000);
  const outputRate = Number(tokenData.audio?.outputRate ?? 24000);
  currentVoiceProvider = selectedVoiceModel.provider;
  beginConversation({
    provider: tokenData.provider ?? selectedVoiceModel.provider,
    model: tokenData.model ?? selectedVoiceModel.model,
  });

  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  startConversationAudioRecording(mediaStream);
  providerInputContext = new AudioContext({ sampleRate: inputRate });
  providerOutputContext = new AudioContext({ sampleRate: outputRate });
  await providerOutputContext.resume();
  providerOutputCursor = providerOutputContext.currentTime;
  wireProviderAgentAudioIntoRecordingMix();
  providerSocket = new WebSocket(providerWebSocketUrl(tokenData.websocketPath));
  providerSocket.binaryType = "arraybuffer";

  providerSocket.addEventListener("open", () => {
    log(`Connected to ${selectedVoiceModel.provider}. Speak naturally to the agent.`);
    setStatus(`Connected to ${selectedVoiceModel.provider}. Speak into your microphone.`);
    configureProviderSession(tokenData, inputRate, outputRate);
    providerPendingInputRate = inputRate;
    if (selectedVoiceModel.provider === "gemini") {
      setStatus("Connected to gemini. Waiting for Gemini setup...");
    } else {
      startProviderAudioInput(inputRate);
      sendResponseCreate(openingInstruction());
    }
    stopButton.disabled = false;
    voiceModelSelect.disabled = true;
  });

  providerSocket.addEventListener("message", handleProviderRealtimeMessage);
  providerSocket.addEventListener("error", () => {
    log(`${selectedVoiceModel.provider} realtime socket error. Check server/provider logs.`);
    setStatus(`${selectedVoiceModel.provider} realtime socket failed.`);
  });
  providerSocket.addEventListener("close", (event) => {
    log(`${selectedVoiceModel.provider} realtime connection closed (${event.code || "no code"}).`);
  });
}

function providerWebSocketUrl(path) {
  const url = new URL(path, window.location.origin);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function configureProviderSession(tokenData, inputRate, outputRate) {
  if (currentVoiceProvider === "grok") {
    sendEvent({
      type: "session.update",
      session: {
        voice: "eve",
        instructions: tokenData.instructions,
        turn_detection: { type: "server_vad" },
        audio: {
          input: { format: { type: "audio/pcm", rate: inputRate } },
          output: { format: { type: "audio/pcm", rate: outputRate } },
        },
        tools: tokenData.tools,
      },
    });
    return;
  }

  if (currentVoiceProvider === "gemini") {
    sendEvent({
      setup: buildGeminiLiveSetup(tokenData),
    });
  }
}

/** Align live setup with Gemini ML Dev websocket logs; Gemini 3.1 native-audio rejects TEXT modality (~1011). */
function buildGeminiLiveSetup(tokenData) {
  const midRaw = String(tokenData.model ?? "");
  const modelPath = midRaw.startsWith("models/") ? midRaw : `models/${midRaw}`;
  const audioOnly = geminiNativeAudioLivePreview(modelPath);
  /** @see https://github.com/googleapis/python-genai/issues/2238 — native-audio Flash Live rejects TEXT modality. */
  const gc = audioOnly
    ? {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: "Puck",
            },
          },
        },
      }
    : {
        responseModalities: ["AUDIO", "TEXT"],
      };
  const decls = (tokenData.tools ?? []).map(geminiFunctionDeclaration).filter(Boolean);
  const setup = {
    model: modelPath,
    generationConfig: gc,
    systemInstruction: {
      parts: [{ text: geminiTruncateSystemText(tokenData.instructions) }],
    },
  };
  if (audioOnly) {
    setup.outputAudioTranscription = {};
    setup.inputAudioTranscription = {};
  }
  if (decls.length > 0) {
    setup.tools = [{ functionDeclarations: decls }];
  }
  return setup;
}

/** Gemini 3.x Flash Live / native-audio Live SKUs: audio modality only (+ transcription blobs at setup root). */
function geminiNativeAudioLivePreview(modelPath) {
  const m = String(modelPath ?? "").toLowerCase();
  if (m.includes("gemini-3.1") && m.includes("live")) return true;
  if (m.includes("native-audio")) return true;
  return false;
}

function geminiTruncateSystemText(text, maxChars = 120_000) {
  const s = String(text ?? "");
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}\n…[instructions truncated]`;
}

async function stopSession() {
  const activeConversation = conversation;
  dataChannel?.close();
  providerSocket?.close();
  peerConnection?.close();
  mediaStream?.getTracks().forEach((track) => track.stop());
  remoteAudio?.remove();
  providerProcessor?.disconnect();
  providerInputSource?.disconnect();
  stopProviderPlayback();
  teardownProviderAgentRecordingTap();
  providerInputContext?.close();
  providerOutputContext?.close();

  dataChannel = undefined;
  providerSocket = undefined;
  peerConnection = undefined;
  mediaStream = undefined;
  remoteAudio = undefined;
  providerProcessor = undefined;
  providerInputSource = undefined;
  providerInputContext = undefined;
  providerOutputContext = undefined;

  startButton.disabled = false;
  stopButton.disabled = true;
  voiceModelSelect.disabled = false;
  setStatus("Stopped");

  if (activeConversation && !isFinalizingConversation) {
    await finalizeConversation();
  }
}

async function startProviderAudioInput(inputRate) {
  if (!providerInputContext || !mediaStream) return;
  providerInputSource = providerInputContext.createMediaStreamSource(mediaStream);
  providerProcessor = providerInputContext.createScriptProcessor(4096, 1, 1);
  providerProcessor.onaudioprocess = (event) => {
    if (providerSocket?.readyState !== WebSocket.OPEN) return;
    const inputSamples = event.inputBuffer.getChannelData(0);
    handleProviderBargeIn(inputSamples);
    const pcmBase64 = float32ToBase64Pcm16(inputSamples);
    if (currentVoiceProvider === "gemini") {
      sendEvent({
        realtimeInput: {
          audio: {
            mimeType: `audio/pcm;rate=${inputRate}`,
            data: pcmBase64,
          },
        },
      });
      return;
    }

    sendEvent({
      type: "input_audio_buffer.append",
      audio: pcmBase64,
    });
  };
  providerInputSource.connect(providerProcessor);
  providerProcessor.connect(providerInputContext.destination);
}

async function handleRealtimeEvent(message) {
  const event = JSON.parse(message.data);

  if (event.type === "conversation.item.truncated") {
    deleteTranscriptDeltasMatchingAssistantItem(event.item_id);
  }

  if (event.type === "input_audio_buffer.speech_started") {
    if (currentVoiceProvider === "openai") speechStartedTruncateOpenAiAssistantAudio();
  }

  if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
    recordAgentFirstAudio();
    if (event.item_id) recentAssistantAudioItemId = event.item_id;
  }

  if (event.type === "response.audio_transcript.delta" || event.type === "response.output_audio_transcript.delta") {
    recordAgentFirstAudio();
    if (event.item_id) recentAssistantAudioItemId = event.item_id;
    appendAgentTranscriptDelta(event);
  }

  if (event.type === "response.audio_transcript.done" || event.type === "response.output_audio_transcript.done") {
    recordAgentFirstAudio();
    const suppressKey = agentTranscriptKey(event);
    if (suppressedAgentTranscriptCommitKeys.delete(suppressKey)) {
      completeAgentTranscript(event);
    } else {
      const transcript = completeAgentTranscript(event);
      if (transcript) {
        log(`Lizzy: ${transcript}`);
        addAssistantTranscriptLine(transcript);
        recordAgentFinalTranscript(transcript);
      }
    }
    agentAudioActive = false;
    agentResponseStartedAtMs = undefined;
    resetAgentPlaybackTurnTracking();
  }

  if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
    log(`${customerTranscriptName()}: ${event.transcript}`);
    recordUserTurn(event.transcript);
    addTranscript("user", event.transcript);
  }

  const call = extractFunctionCall(event);
  if (!call) return;
  const toolCallKey =
    call.callId !== undefined && call.callId !== null && `${call.callId}`.trim() !== ""
      ? String(call.callId)
      : `${call.name}:${call.rawArguments ?? ""}`;
  providerFunctionNames.set(toolCallKey, call.name);
  if (handledToolCallIds.has(toolCallKey)) return;
  handledToolCallIds.add(toolCallKey);

  let output;
  let savedToolCallId;
  const toolStartMs = performance.now();
  try {
    const args = call.rawArguments ? JSON.parse(call.rawArguments) : {};
    savedToolCallId = addToolCall(call.name, args, toolCallKey);

    if (call.name === "update_collected_field") {
      let value = args.value;
      if (args.field === "phoneNumber") {
        value = normalizePhoneForDraft(args.value);
      }
      recordFieldUpdate(args.field, value);
      draft[args.field] = value;
      if (args.field === "firstName") {
        updateCustomerTranscriptLabels();
      }
      if (args.field === "vin") {
        await decodeVin(value);
      }
      renderFields();
      output = {
        ok: true,
        missingFields: missingFields(),
        missingVehicleFields: missingVehicleFields(),
        summary: summary(),
      };
    } else if (call.name === "update_vehicle_field") {
      draft.vehicle = {
        vin: draft.vin ?? draft.vehicle?.vin,
        ...draft.vehicle,
        [args.field]: args.value,
      };
      renderVehicle();
      output = {
        ok: true,
        missingVehicleFields: missingVehicleFields(),
        vehicle: draft.vehicle,
        summary: vehicleSummary(),
      };
    } else if (call.name === "collect_payment_detail") {
      draft.payment = {
        ...draft.payment,
        [args.field]: normalizePaymentValue(args.field, args.value),
      };
      const missingPayment = missingPaymentFields();
      if (missingPayment.length === 0) {
        draft.paymentTransaction = {
          status: "success",
          approvedAt: new Date().toISOString(),
        };
        resumeConversationAudioRecording();
      }
      renderPayment();
      output = {
        ok: true,
        missingPaymentFields: missingPayment,
        paymentSummary: paymentSummary(),
        transactionStatus: draft.paymentTransaction?.status,
        recordingStatus: draft.paymentTransaction?.status === "success" ? "resumed" : "paused",
      };
      log(`Payment detail captured: ${args.field} (not stored)`);
    } else if (call.name === "generate_quote") {
      const missing = missingFields();
      const missingVehicle = missingVehicleFields();
      if (missing.length > 0 || missingVehicle.length > 0) {
        throw new Error(
          `Cannot generate quote yet. Missing: ${[...missing, ...missingVehicle.map((field) => `vehicle.${field}`)].join(", ")}`,
        );
      }
      draft.quote = generateQuoteDraft();
      renderQuote();
      output = {
        ok: true,
        quote: draft.quote,
        summary: quoteSummary(),
      };
      log(`Generated quote: ${quoteSummary()}`);
    } else if (call.name === "begin_payment_collection") {
      pauseConversationAudioRecording();
      output = {
        ok: true,
        message: "Payment collection can begin. Audio recording is paused so payment audio is not stored.",
        recordingStatus: "paused",
      };
    } else if (call.name === "search_auto_insurance_knowledge") {
      const ragStartMs = performance.now();
      const response = await fetch("/api/geico/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: args.query }),
      });
      const searched = await response.json();
      const ragLatencyMs = Math.round(performance.now() - ragStartMs);
      if (!response.ok) {
        throw new Error(searched.error ?? "Could not search GEICO data.");
      }
      output = {
        ok: true,
        results: searched.results,
        ragLatencyMs,
        instruction: "Answer directly and naturally from these GEICO auto-insurance results. Do not mention snippets, documents, data, searching, checking, reviewing, the app, or looking anything up. Synthesize the answer in your own words. If the results do not answer the question, say you can help with GEICO auto insurance quote and coverage questions.",
      };
    } else if (call.name === "save_confirmed_intake") {
      const prerequisites = prerequisiteBlockingSaveReason();
      if (prerequisites) {
        throw new Error(prerequisites);
      }
      const saveStartMs = performance.now();
      const saveResponse = await fetch("/api/browser-intake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intake: intakeWithoutPayment() }),
      });
      const saved = await saveResponse.json();
      const saveDurationMs = Math.round(performance.now() - saveStartMs);
      if (!saveResponse.ok) {
        throw new Error(saved.error ?? "Could not save intake.");
      }
      recordCompletionSave();
      output = {
        ok: true,
        id: saved.id,
        saveDurationMs,
      };
      log(`Saved confirmed intake: ${saved.id}`);
    } else {
      output = {
        ok: false,
        error: `Unknown tool: ${call.name}`,
      };
    }
  } catch (error) {
    output = {
      ok: false,
      error: error.message,
    };
  }

  if (!output.ok && output?.error) {
    log(`Tool "${call.name}" failed: ${output.error}`);
  }

  const toolDurationMs = Math.round(performance.now() - toolStartMs);
  updateToolCallOutput(savedToolCallId, output, toolDurationMs);
  recordToolEval(call.name, output, toolDurationMs);
  sendToolOutput(toolCallKey, output);
}

async function handleProviderRealtimeMessage(message) {
  if (message.data instanceof ArrayBuffer) {
    playPcm16Bytes(new Uint8Array(message.data), currentVoiceProvider === "gemini" ? 24000 : 24000);
    return;
  }
  const raw = typeof message.data === "string" ? message.data : await message.data.text?.();
  if (!raw) return;

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    log(`Realtime message was not JSON (first 200 chars): ${String(raw).slice(0, 200)}`);
    return;
  }

  if (event.type === "provider.open") {
    log(`${event.provider} upstream connected (${event.model}).`);
    return;
  }
  if (event.type === "provider.error") {
    log(`Provider error: ${event.error}`);
    setStatus("Provider realtime connection failed. Check the log.");
    return;
  }

  if (currentVoiceProvider === "gemini") {
    await handleGeminiRealtimeEvent(event);
    return;
  }

  if (event.type === "response.output_audio.delta" && event.delta) {
    recordAgentFirstAudio();
    logOnce("providerAudio", `${currentVoiceProvider} audio started.`);
    playPcm16Base64(event.delta, 24000);
  }
  /** Do not persist `response.output_text*`: it can include text that never became speech; rely on output audio transcripts in `handleRealtimeEvent`. */

  await handleRealtimeEvent({ data: raw });
}

function finalizeGeminiSpeechTranscript() {
  const transcript = completeAgentTranscript({ response_id: "gemini" });

  agentAudioActive = false;
  agentResponseStartedAtMs = undefined;
  resetAgentPlaybackTurnTracking();

  if (!transcript) return;

  log(`Lizzy: ${transcript}`);
  addAssistantTranscriptLine(transcript);
  recordAgentFinalTranscript(transcript);
}

/** Gemini often streams output transcription as short spans; stitch so we don't log only the last fragment. */
function mergeGeminiOutputTranscription(prevRaw, incomingRaw) {
  const a = String(prevRaw ?? "").trim();
  const b = String(incomingRaw ?? "").trim();
  if (!b) return a;
  if (!a) return b;
  if (b.startsWith(a)) return b;
  if (a.startsWith(b)) return a;
  if (a.endsWith(b)) return a;
  if (b.endsWith(a)) return b;
  if (b.includes(a)) return b;
  if (a.includes(b)) return a;
  return `${a} ${b}`.replace(/\s+/g, " ").trim();
}

/** Normalize Gemini Live `toolCall.functionCalls`, snake_case aliases, and per-part declarations. */
function collectGeminiFunctionCalls(event) {
  const collected = [];
  const pushAll = (calls) => {
    if (!Array.isArray(calls)) return;
    for (const c of calls) {
      if (c && typeof c === "object") collected.push(c);
    }
  };

  pushAll(event.toolCall?.functionCalls);
  pushAll(event.toolCall?.function_calls);
  pushAll(event.tool_call?.functionCalls);
  pushAll(event.tool_call?.function_calls);

  const sc = event.serverContent ?? event.server_content;
  const parts = sc?.modelTurn?.parts ?? sc?.model_turn?.parts ?? [];
  for (const part of parts) {
    const fc = part.functionCall ?? part.function_call;
    if (fc && typeof fc === "object") collected.push(fc);
  }

  return collected;
}

async function handleGeminiRealtimeEvent(event) {
  const errPayload = event.error ?? event.error_details;
  if (errPayload) {
    log(`Gemini realtime error from server: ${JSON.stringify(errPayload).slice(0, 900)}`);
    return;
  }

  if (event.setupComplete ?? event.setup_complete) {
    log("Gemini setup complete. Starting microphone stream.");
    setStatus("Connected to gemini. Speak into your microphone.");
    startProviderAudioInput(providerPendingInputRate);
    sendResponseCreate(openingInstruction());
    return;
  }

  const sc = event.serverContent ?? event.server_content;
  const inputTranscript =
    event.inputTranscription ?? event.input_transcription ?? sc?.inputTranscription ?? sc?.input_transcription;
  if (inputTranscript?.text && inputTranscript.finished !== false) {
    await handleRealtimeEvent({
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: inputTranscript.text,
      }),
    });
  }

  const outputTranscript =
    event.outputTranscription ??
    event.output_transcription ??
    sc?.outputTranscription ??
    sc?.output_transcription;
  // Gemini may send overlapping phrases, deltas, or full cumulative text — stitch instead of overwriting.
  if (outputTranscript?.text?.trim()) {
    recordAgentFirstAudio();
    const prev = agentTranscriptDeltas.get("gemini") ?? "";
    agentTranscriptDeltas.set("gemini", mergeGeminiOutputTranscription(prev, outputTranscript.text.trim()));
  }

  const parts = sc?.modelTurn?.parts ?? sc?.model_turn?.parts ?? [];
  const hasBufferedSpeech = typeof outputTranscript?.text === "string" && outputTranscript.text.trim() !== "";

  parts.forEach((part) => {
    const inlineData = part.inlineData ?? part.inline_data;
    if (inlineData?.data) {
      recordAgentFirstAudio();
      logOnce("providerAudio", `${currentVoiceProvider} audio started.`);
      playPcm16Base64(inlineData.data, 24000);
    }
    const partText = part.text;
    if (!hasBufferedSpeech && partText) {
      recordAgentFirstAudio();
      appendAgentTranscriptDelta({ response_id: "gemini", delta: partText });
    }
    // Omit part.text when output_audio_transcription is active — it duplicates the same speech.
  });

  for (const functionCall of collectGeminiFunctionCalls(event)) {
    const rawFcId = functionCall.id;
    if (rawFcId === undefined || rawFcId === null || `${rawFcId}`.trim() === "") {
      log(`Gemini tool call skipped — missing tool call id (function: ${functionCall.name ?? "unknown"}).`);
      continue;
    }
    const callId = String(rawFcId);
    const args = parseGeminiFunctionArgs(functionCall.args ?? functionCall.arguments ?? {});
    log(`Gemini tool call: ${functionCall.name}`);
    await handleRealtimeEvent({
      data: JSON.stringify({
        type: "response.function_call_arguments.done",
        name: functionCall.name,
        call_id: callId,
        arguments: JSON.stringify(args),
      }),
    });
  }

  if (sc?.turnComplete || sc?.turn_complete) {
    finalizeGeminiSpeechTranscript();
  }
}

function parseGeminiFunctionArgs(args) {
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  if (!args || typeof args !== "object") return {};
  if (typeof args.fields === "object" && args.fields !== null && !Array.isArray(args.fields)) {
    return structFieldsToPlainObject(args.fields);
  }
  return args;
}

/** Best-effort conversion when args arrive as protobuf Struct JSON `{ fields: { k: { stringValue: ... } } }`. */
function structFieldsToPlainObject(fields) {
  const out = {};
  for (const [key, wrapped] of Object.entries(fields)) {
    if (!wrapped || typeof wrapped !== "object") continue;
    if (wrapped.stringValue !== undefined) out[key] = wrapped.stringValue;
    else if (wrapped.numberValue !== undefined) out[key] = wrapped.numberValue;
    else if (wrapped.boolValue !== undefined) out[key] = wrapped.boolValue;
    else if (wrapped.structValue?.fields) out[key] = structFieldsToPlainObject(wrapped.structValue.fields);
    else if (Array.isArray(wrapped.listValue?.values)) out[key] = wrapped.listValue.values.map(protoValueToJs);
  }
  return out;
}

function protoValueToJs(wrapped) {
  if (!wrapped || typeof wrapped !== "object") return wrapped;
  if (wrapped.stringValue !== undefined) return wrapped.stringValue;
  if (wrapped.numberValue !== undefined) return wrapped.numberValue;
  if (wrapped.boolValue !== undefined) return wrapped.boolValue;
  if (wrapped.structValue?.fields) return structFieldsToPlainObject(wrapped.structValue.fields);
  if (Array.isArray(wrapped.listValue?.values)) return wrapped.listValue.values.map(protoValueToJs);
  return undefined;
}

function estimateOpenAiAssistantAudioHeardMs() {
  if (!remoteAudio) return undefined;
  try {
    return Math.round(Math.max(0, remoteAudio.currentTime) * 1000);
  } catch {
    return undefined;
  }
}

function speechStartedTruncateOpenAiAssistantAudio() {
  if (!recentAssistantAudioItemId || !agentAudioActive) return;
  const ms = estimateOpenAiAssistantAudioHeardMs();
  if (!Number.isFinite(ms) || ms <= 0) return;
  sendEvent({
    type: "conversation.item.truncate",
    item_id: recentAssistantAudioItemId,
    content_index: 0,
    audio_end_ms: ms,
  });
}

function deleteTranscriptDeltasMatchingAssistantItem(itemId) {
  if (itemId === undefined || itemId === null || `${itemId}`.trim() === "") return;
  const needle = `${itemId}`;
  for (const key of [...agentTranscriptDeltas.keys()]) {
    if (key === needle || key.split(":").includes(needle)) {
      agentTranscriptDeltas.delete(key);
    }
  }
}

function resetAgentPlaybackTurnTracking() {
  agentTurnPlaybackSlices = [];
}

function recordAgentPlaybackSlice(startAtSeconds, durationSeconds) {
  if (!(durationSeconds > 0) || !providerOutputContext) return;
  if (!(currentVoiceProvider === "gemini" || currentVoiceProvider === "grok")) return;
  agentTurnPlaybackSlices.push({ startAt: startAtSeconds, endAt: startAtSeconds + durationSeconds });
}

/** How much of the scheduled agent PCM in this turn had started playing before `stopAudioContextClock`. */
function approximateWordsHeardFraction(stopAudioContextClock) {
  if (!agentTurnPlaybackSlices.length) return 0;
  let heardSec = 0;
  let scheduledSec = 0;
  for (const { startAt, endAt } of agentTurnPlaybackSlices) {
    scheduledSec += endAt - startAt;
    const overlapEnd = Math.min(endAt, stopAudioContextClock);
    heardSec += Math.max(0, overlapEnd - startAt);
  }
  if (scheduledSec < 1e-4) return 0;
  return Math.min(1, Math.max(0, heardSec / scheduledSec));
}

function truncateTranscriptToApproxPlayedRatio(fullText, ratio) {
  const text = String(fullText ?? "").trim();
  if (!text || ratio >= 0.997) return text;
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return text;
  if (ratio <= 0.01) return "";
  const n = Math.min(words.length, Math.floor(words.length * ratio));
  if (n < 1) return "";
  return words.slice(0, n).join(" ");
}

function commitInterruptedProviderAgentTranscripts() {
  if (currentVoiceProvider !== "gemini" && currentVoiceProvider !== "grok") return;
  if (!providerOutputContext) return;
  const stopClock = providerOutputContext.currentTime;
  const ratio = approximateWordsHeardFraction(stopClock);
  if (ratio >= 0.88) {
    resetAgentPlaybackTurnTracking();
    return;
  }
  const keysSnapshot = [...agentTranscriptDeltas.keys()];
  for (const key of keysSnapshot) {
    const pending = agentTranscriptDeltas.get(key);
    if (!pending?.trim()) {
      agentTranscriptDeltas.delete(key);
      suppressedAgentTranscriptCommitKeys.delete(key);
      continue;
    }
    const spoken = truncateTranscriptToApproxPlayedRatio(pending, ratio).trim();
    agentTranscriptDeltas.delete(key);
    if (currentVoiceProvider === "grok") suppressedAgentTranscriptCommitKeys.add(key);
    if (spoken) {
      log(`Lizzy: ${spoken}`);
      addAssistantTranscriptLine(spoken);
      recordAgentFinalTranscript(spoken);
    }
  }
  resetAgentPlaybackTurnTracking();
}

function appendAgentTranscriptDelta(event) {
  const key = agentTranscriptKey(event);
  agentTranscriptDeltas.set(key, `${agentTranscriptDeltas.get(key) ?? ""}${event.delta ?? ""}`);
}

function completeAgentTranscript(event) {
  const key = agentTranscriptKey(event);
  const transcript = String(event.transcript ?? agentTranscriptDeltas.get(key) ?? "").trim();
  agentTranscriptDeltas.delete(key);
  return transcript;
}

function agentTranscriptKey(event) {
  return [event.response_id, event.item_id, event.output_index, event.content_index].filter(Boolean).join(":") || "current";
}

function extractFunctionCall(event) {
  if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
    return {
      name: event.item.name,
      callId: event.item.call_id,
      rawArguments: event.item.arguments,
    };
  }

  if (event.type === "response.function_call_arguments.done") {
    return {
      name: event.name,
      callId: event.call_id,
      rawArguments: event.arguments,
    };
  }

  return undefined;
}

/**
 * After `tool_response`, Gemini Live resumes generation once the client queues more input (see sync tools).
 * OpenAI bridges this via `response.create`; here we mirror with `realtimeInput.text`.
 */
function geminiRealtimeNudgeAfterTool(toolName, output) {
  const name = toolName ?? "";
  if (!output?.ok && output?.error !== undefined && output?.error !== null && output?.error !== "") {
    return `The "${name}" tool failed: ${String(output.error).slice(0, 400)}. Speak briefly that something went wrong, fix it, then continue naturally.`;
  }
  if (output?.ok && name === "generate_quote") {
    return (
      "generate_quote succeeded. Immediately tell the caller the monthly premium, term length, and coverage summary exactly as returned—do not paraphrase as free numbers beforehand. Proceed toward checkout flows using tools."
    );
  }
  if (output?.ok && name === "save_confirmed_intake") {
    return (
      "save_confirmed_intake succeeded. Briefly reassure them their quote details were saved. If they requested an id reference, summarize from the tool output only."
    );
  }
  if (output?.ok && name === "begin_payment_collection") {
    return (
      "You just called begin_payment_collection (recording paused for privacy). Immediately continue aloud with Lizzy's next scripted checkout line—the first concrete payment question—and keep guiding the caller; do not wait for extra silence."
    );
  }
  return undefined;
}

function sendToolOutput(callId, output) {
  if (currentVoiceProvider === "gemini") {
    const fname = providerFunctionNames.get(callId);
    sendEvent({
      toolResponse: {
        functionResponses: [
          {
            id: String(callId),
            name: fname ?? "unknown_tool",
            response: { output },
          },
        ],
      },
    });
    sendResponseCreate(geminiRealtimeNudgeAfterTool(fname ?? "", output));
    return;
  }

  sendEvent({
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(output),
    },
  });

  sendResponseCreate();
}

function sendResponseCreate(instructions) {
  if (currentVoiceProvider === "gemini") {
    sendEvent({
      realtimeInput: {
        text: instructions ?? "Please continue.",
      },
    });
    return;
  }

  sendEvent({
    type: "response.create",
    response: instructions ? { instructions } : undefined,
  });
}

function sendEvent(event) {
  if (currentVoiceProvider !== "openai" && providerSocket?.readyState === WebSocket.OPEN) {
    providerSocket.send(JSON.stringify(event));
    return;
  }
  if (dataChannel?.readyState === "open") {
    dataChannel.send(JSON.stringify(event));
  }
}

function missingFields() {
  return fields.filter((field) => draft[field] === undefined || draft[field] === "");
}

function missingVehicleFields() {
  if (!draft.vin) return [...vehicleFields];
  return vehicleFields.filter((field) => draft.vehicle?.[field] === undefined || draft.vehicle?.[field] === "");
}

function missingPaymentFields() {
  return paymentFields.filter((field) => draft.payment?.[field] === undefined || draft.payment?.[field] === "");
}

function prerequisiteBlockingSaveReason() {
  const missingPersonal = missingFields();
  if (missingPersonal.length > 0) {
    return `Cannot save yet. Missing required fields: ${missingPersonal.join(", ")}.`;
  }
  const missingVehicle = missingVehicleFields();
  if (missingVehicle.length > 0) {
    return `Cannot save yet. Missing vehicle details: ${missingVehicle.join(", ")}.`;
  }
  if (!draft.quote) {
    return "Cannot save yet. A quote must be generated first.";
  }
  const missingPayment = missingPaymentFields();
  if (missingPayment.length > 0) {
    return `Cannot save yet. Missing payment fields: ${missingPayment.join(", ")}.`;
  }
  return null;
}

function summary() {
  return [
    ...fields.map((field) => `${labels[field]}: ${draft[field] ?? "missing"}`),
    `Vehicle: ${vehicleSummary()}`,
    `Mock quote: ${quoteSummary()}`,
    `Payment: ${paymentSummary()}`,
  ].join("\n");
}

function renderFields() {
  fieldsEl.innerHTML = fields
    .map((field) => `<dt>${labels[field]}</dt><dd>${escapeHtml(draft[field] ?? "missing")}</dd>`)
    .join("");
}

async function decodeVin(vin) {
  try {
    log("Decoding VIN for vehicle details...");
    const response = await fetch("/api/vin/decode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vin }),
    });
    const decoded = await response.json();
    if (!response.ok) {
      throw new Error(decoded.error ?? "Could not decode VIN.");
    }

    draft.vehicle = decoded.vehicle;
    renderVehicle();
    log(`Vehicle decoded: ${vehicleSummary()}`);
  } catch (error) {
    draft.vehicle = undefined;
    renderVehicle();
    log(`VIN decode warning: ${error.message}`);
  }
}

function renderVehicle() {
  const vehicle = draft.vehicle ?? {};
  const rows = {
    VIN: vehicle.vin,
    Year: vehicle.year,
    Make: vehicle.make,
    Model: vehicle.model,
    Trim: vehicle.trim,
  };

  vehicleEl.innerHTML = Object.entries(rows)
    .map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value ?? "missing")}</dd>`)
    .join("");
}

function renderQuote() {
  const quote = draft.quote ?? {};
  const rows = {
    "Monthly premium": quote.monthlyPremium ? `$${quote.monthlyPremium}` : undefined,
    "Term": quote.termMonths ? `${quote.termMonths} months` : undefined,
    Coverage: quote.coverageSummary,
  };

  quoteEl.innerHTML = Object.entries(rows)
    .map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value ?? "missing")}</dd>`)
    .join("");
}

function renderPayment() {
  const payment = draft.payment ?? {};
  const rows = {
    "Card number": payment.cardNumber ? `ending in ${payment.cardNumber.slice(-4)}` : undefined,
    "Expiration month": payment.expirationMonth,
    "Expiration year": payment.expirationYear,
    CVV: payment.cvv ? "captured" : undefined,
    "Transaction status": draft.paymentTransaction?.status,
  };

  paymentEl.innerHTML = Object.entries(rows)
    .map(([label, value]) => `<dt>${label}</dt><dd>${escapeHtml(value ?? "missing")}</dd>`)
    .join("");
}

function generateQuoteDraft() {
  const monthlyPremium = Math.floor(Math.random() * 96) + 85;

  return {
    monthlyPremium,
    termMonths: 6,
    coverageSummary:
      "Full auto package including liability, comprehensive, collision, medical payments or PIP where applicable, uninsured or underinsured motorist coverage, and roadside support.",
  };
}

function quoteSummary() {
  const quote = draft.quote;
  if (!quote) return "not generated yet";

  return `$${quote.monthlyPremium} per month for ${quote.termMonths} months. ${quote.coverageSummary}`;
}

function paymentSummary() {
  const payment = draft.payment;
  if (!payment) return "not collected";

  const lastFour = payment.cardNumber?.slice(-4);
  return lastFour ? `card ending in ${lastFour}; not stored` : "partially collected; not stored";
}

function normalizePhoneForDraft(value) {
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? String(Math.trunc(value))
      : String(value ?? "").trim();
  const digits = raw.replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (!/^\d{10}$/.test(ten)) {
    throw new Error("Phone must be 10 US digits, or 11 digits beginning with country code 1 (+1).");
  }
  return ten;
}

function normalizePaymentValue(field, value) {
  const raw = String(value ?? "").trim();
  if (field === "cardNumber") {
    const normalized = raw.replace(/\D/g, "");
    if (!/^\d{13,19}$/.test(normalized)) {
      throw new Error("Card number must be 13 to 19 digits.");
    }
    return normalized;
  }
  if (field === "expirationMonth" && !/^(0?[1-9]|1[0-2])$/.test(raw)) {
    throw new Error("Expiration month must be 1 through 12.");
  }
  if (field === "expirationYear" && !/^(\d{2}|\d{4})$/.test(raw)) {
    throw new Error("Expiration year must be 2 or 4 digits.");
  }
  if (field === "cvv" && !/^\d{3,4}$/.test(raw)) {
    throw new Error("CVV must be 3 or 4 digits.");
  }
  return raw;
}

function intakeWithoutPayment() {
  const { payment, ...intake } = draft;
  return intake;
}

async function loadVoiceModelOptions() {
  try {
    const response = await fetch("/api/realtime/models");
    const data = await response.json();
    const options = response.ok && Array.isArray(data.options) ? data.options : [fallbackVoiceModel];
    renderVoiceModelOptions(options, data.defaultProvider);
  } catch (error) {
    renderVoiceModelOptions([fallbackVoiceModel], fallbackVoiceModel.provider);
    voiceModelNote.textContent = "Using default OpenAI model options.";
  }
}

function renderVoiceModelOptions(options, defaultProvider) {
  voiceModelSelect.innerHTML = options
    .map((option) => {
      const value = `${option.provider}|${option.model}`;
      const suffix = option.available ? "" : " (missing API key)";
      const selected = option.provider === defaultProvider ? " selected" : "";
      return `<option value="${escapeAttribute(value)}"${selected}>${escapeHtml(`${option.label}${suffix}`)}</option>`;
    })
    .join("");
  updateVoiceModelNote(options);
  voiceModelSelect.addEventListener("change", () => updateVoiceModelNote(options));
}

function updateVoiceModelNote(options) {
  const selected = getSelectedVoiceModel();
  const option = options.find((item) => item.provider === selected.provider && item.model === selected.model);
  voiceModelNote.textContent = option?.available
    ? `This conversation will use ${option.label}.`
    : `${option?.label ?? selected.model} needs its API key before it can run.`;
}

function getSelectedVoiceModel() {
  const [provider = fallbackVoiceModel.provider, model = fallbackVoiceModel.model] = String(
    voiceModelSelect?.value ?? `${fallbackVoiceModel.provider}|${fallbackVoiceModel.model}`,
  ).split("|");
  return { provider, model };
}

function beginConversation(voiceModel = getSelectedVoiceModel()) {
  const now = new Date();
  conversation = {
    id: crypto.randomUUID(),
    mode: callMode,
    voiceModel,
    startedAt: now.toISOString(),
    endedAt: undefined,
    customerName: undefined,
    transcripts: [],
    toolCalls: [],
    finalState: {},
    recordingNote:
      "Conversation audio is stored as one mixed file. Recording pauses during payment collection and resumes after the transaction succeeds.",
    transcriptNote:
      "Lizzy's lines are captured from realtime output-audio transcripts. After barge-in we trim Gemini/Grok text to approximate played PCM; WebRTC/OpenAI asks the server to truncate unheard assistant audio.",
    evals: {
      responseLatencies: [],
      toolDurations: [],
      corrections: [],
      fieldsCorrected: [],
      reAskCount: 0,
      interruptionCount: 0,
      silentFailureCount: 0,
      timeToCompletionSaveMs: undefined,
      totalCallDurationMs: undefined,
    },
  };
  conversation.startedAtMs = performance.now();
  mixedAudioChunks = [];
  isPaymentCollectionActive = false;
  audioPausedAtMs = undefined;
  totalAudioPausedMs = 0;
  pendingUserTurn = undefined;
  agentAudioActive = false;
  agentResponseStartedAtMs = undefined;
  handledToolCallIds.clear();
  oneTimeLogs.clear();
  agentTranscriptDeltas.clear();
  suppressedAgentTranscriptCommitKeys.clear();
  resetAgentPlaybackTurnTracking();
  recentAssistantAudioItemId = undefined;
  log(`Conversation recording started (${displayVoiceModel(voiceModel)})`);
}

function elapsedMs() {
  return Math.max(0, Math.round(performance.now() - (conversation?.startedAtMs ?? performance.now())));
}

function elapsedAudioMs() {
  const currentPauseMs = audioPausedAtMs ? performance.now() - audioPausedAtMs : 0;
  return Math.max(0, Math.round(elapsedMs() - totalAudioPausedMs - currentPauseMs));
}

function ensureEvals() {
  if (!conversation) return undefined;
  conversation.evals ??= {};
  conversation.evals.responseLatencies ??= [];
  conversation.evals.toolDurations ??= [];
  conversation.evals.corrections ??= [];
  conversation.evals.fieldsCorrected ??= [];
  conversation.evals.reAskCount ??= 0;
  conversation.evals.interruptionCount ??= 0;
  conversation.evals.silentFailureCount ??= 0;
  return conversation.evals;
}

function recordUserTurn(text) {
  const evals = ensureEvals();
  if (!evals) return;
  if (agentAudioActive) {
    evals.interruptionCount += 1;
  }
  if (pendingUserTurn && !agentAudioActive && agentResponseStartedAtMs === undefined) {
    pendingUserTurn.text = `${pendingUserTurn.text}\n${text}`;
    return;
  }
  pendingUserTurn = {
    id: crypto.randomUUID(),
    text,
    audioTimestampMs: elapsedAudioMs(),
    performanceMs: performance.now(),
    firstAudioLatencyMs: undefined,
  };
  if (agentResponseStartedAtMs !== undefined) {
    pendingUserTurn.firstAudioLatencyMs = Math.max(0, Math.round(agentResponseStartedAtMs - pendingUserTurn.performanceMs));
  }
}

function recordAgentFirstAudio() {
  agentResponseStartedAtMs ??= performance.now();
  agentAudioActive = true;
  if (!pendingUserTurn || pendingUserTurn.firstAudioLatencyMs !== undefined) return;
  pendingUserTurn.firstAudioLatencyMs = Math.max(0, Math.round(agentResponseStartedAtMs - pendingUserTurn.performanceMs));
}

function recordAgentFinalTranscript(transcript) {
  const evals = ensureEvals();
  if (!evals || !pendingUserTurn) return;
  const finalTranscriptLatencyMs = Math.round(performance.now() - pendingUserTurn.performanceMs);
  evals.responseLatencies.push({
    userText: pendingUserTurn.text,
    agentText: transcript,
    userTimestampMs: pendingUserTurn.audioTimestampMs,
    firstAudioLatencyMs: pendingUserTurn.firstAudioLatencyMs ?? 0,
    finalTranscriptLatencyMs,
  });
  if (/\b(repeat|say that again|try again|spell it|unclear|didn't catch|couldn't catch)\b/i.test(transcript)) {
    evals.reAskCount += 1;
  }
  pendingUserTurn = undefined;
}

function recordFieldUpdate(field, value) {
  const evals = ensureEvals();
  if (!evals || !field) return;
  const previousValue = draft[field];
  if (previousValue !== undefined && previousValue !== "" && String(previousValue) !== String(value)) {
    const correctionEndMs = elapsedAudioMs();
    const anchors = correctionPlaybackAnchors(correctionEndMs, field, previousValue, value);
    evals.corrections.push({
      field,
      previousValue,
      newValue: value,
      timestampMs: correctionEndMs,
      userUtteranceStartMs: anchors.userUtteranceStartMs,
      playTimestampMs: anchors.playTimestampMs,
    });
    if (!evals.fieldsCorrected.includes(field)) {
      evals.fieldsCorrected.push(field);
    }
  }
}

function correctionPlaybackAnchors(correctionEndMs, field, previousValue, newValue) {
  const MAX_USER_WINDOW_MS = 5 * 60 * 1000;
  const MAX_PRIOR_WINDOW_MS = 3 * 60 * 1000;
  const MAX_REWIND_MS = 90 * 1000;

  const pend = pendingUserTurn?.audioTimestampMs;
  if (
    pendingUserTurn &&
    Number.isFinite(pend) &&
    pend <= correctionEndMs &&
    correctionEndMs - pend < MAX_USER_WINDOW_MS
  ) {
    return { userUtteranceStartMs: pend, playTimestampMs: pend };
  }

  let playMs = estimatePlaybackStartFromUtteranceEndMs(correctionEndMs, `${previousValue ?? ""} ${newValue ?? ""}`.trim());

  const priorTs = lastPriorUpdateCollectedFieldMs(field, correctionEndMs);
  if (priorTs !== undefined && correctionEndMs - priorTs < MAX_PRIOR_WINDOW_MS) {
    playMs = Math.min(playMs, Math.max(0, priorTs - 1200));
  }

  playMs = Math.min(playMs, correctionEndMs);
  playMs = Math.max(playMs, Math.max(0, correctionEndMs - MAX_REWIND_MS));

  return { userUtteranceStartMs: undefined, playTimestampMs: playMs };
}

function lastPriorUpdateCollectedFieldMs(field, beforeMs) {
  const threshold = beforeMs - 100;
  let best;
  for (const call of conversation?.toolCalls ?? []) {
    if (call.name !== "update_collected_field") continue;
    if (call.args?.field !== field) continue;
    const t = call.timestampMs;
    if (!Number.isFinite(t) || t >= threshold) continue;
    best = best === undefined ? t : Math.max(best, t);
  }
  return best;
}

function estimatePlaybackStartFromUtteranceEndMs(endMs, text) {
  const words = String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const estimatedDurationMs = Math.min(9000, Math.max(1400, words * 400));
  return Math.max(0, Math.round(Number(endMs ?? 0) - estimatedDurationMs));
}

function recordCompletionSave() {
  const evals = ensureEvals();
  if (!evals) return;
  evals.timeToCompletionSaveMs = elapsedMs();
}

function recordToolEval(name, output, durationMs) {
  const evals = ensureEvals();
  if (!evals) return;
  evals.toolDurations.push({
    name,
    durationMs,
    timestampMs: elapsedAudioMs(),
  });
  if (output?.ok === false) {
    evals.silentFailureCount += 1;
  }
}

function addTranscript(role, text) {
  if (!conversation) return;
  if (isPaymentCollectionActive) return;
  const speaker = transcriptSpeaker(role);
  conversation.transcripts.push({
    id: crypto.randomUUID(),
    role: speaker,
    speaker,
    sourceRole: role,
    text: text.trim(),
    timestampMs: elapsedAudioMs(),
    audioTrack: "conversation",
  });
}

/** Extends the last Lizzy line when Gemini/Grok sends incremental transcription of the same utterance. */
function addAssistantTranscriptLine(text) {
  if (!conversation) return;
  if (isPaymentCollectionActive) return;
  const next = String(text ?? "").trim();
  if (!next) return;
  const rows = conversation.transcripts;
  const last = rows[rows.length - 1];
  if (last?.sourceRole === "agent") {
    const prev = String(last.text ?? "").trim();
    if (prev && next.startsWith(prev)) {
      last.text = next;
      return;
    }
    if (prev && prev.startsWith(next) && next.length < prev.length) {
      return;
    }
  }
  const speaker = transcriptSpeaker("agent");
  rows.push({
    id: crypto.randomUUID(),
    role: speaker,
    speaker,
    sourceRole: "agent",
    text: next,
    timestampMs: elapsedAudioMs(),
    audioTrack: "conversation",
  });
}

function transcriptSpeaker(role) {
  return role === "agent" ? "Lizzy" : customerTranscriptName();
}

function customerTranscriptName() {
  return String(draft.firstName ?? "").trim() || "Customer";
}

function updateCustomerTranscriptLabels() {
  if (!conversation) return;
  const customerName = customerTranscriptName();
  conversation.transcripts.forEach((entry) => {
    if (entry.sourceRole === "user" || entry.role === "user" || entry.role === "Customer") {
      entry.role = customerName;
      entry.speaker = customerName;
      entry.sourceRole = "user";
    }
    if (entry.sourceRole === "agent" || entry.role === "agent") {
      entry.role = "Lizzy";
      entry.speaker = "Lizzy";
      entry.sourceRole = "agent";
    }
  });
}

function addToolCall(name, args, callId) {
  if (!conversation) return undefined;
  const id = crypto.randomUUID();
  conversation.toolCalls.push({
    id,
    callId,
    name,
    args: redactToolArgs(name, args),
    timestampMs: elapsedAudioMs(),
  });
  return id;
}

function updateToolCallOutput(id, output, durationMs) {
  if (!conversation || !id) return;
  const toolCall = conversation.toolCalls.find((call) => call.id === id);
  if (!toolCall) return;
  toolCall.output = output;
  toolCall.durationMs = durationMs;
  toolCall.completedAtMs = elapsedAudioMs();

  if (output?.ok === false) {
    const endRef = Number.isFinite(toolCall.completedAtMs) ? toolCall.completedAtMs : toolCall.timestampMs;
    const u = pendingUserTurn?.audioTimestampMs;
    if (Number.isFinite(u) && u <= Number(endRef) + 750) {
      toolCall.userUtteranceStartMs = u;
    }
  }
}

function startConversationAudioRecording(userStream) {
  if (!window.MediaRecorder || userStream.getAudioTracks().length === 0) return;
  audioContext = new AudioContext();
  mixedAudioDestination = audioContext.createMediaStreamDestination();
  audioContext.createMediaStreamSource(userStream).connect(mixedAudioDestination);
  mixedAudioChunks = [];
  const mimeType = pickMimeType();
  mixedAudioRecorder = mimeType
    ? new MediaRecorder(mixedAudioDestination.stream, { mimeType })
    : new MediaRecorder(mixedAudioDestination.stream);
  mixedAudioRecorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      mixedAudioChunks.push(event.data);
    }
  });
  mixedAudioRecorder.start(1000);
}

function addAgentAudioToConversationRecording(agentStream) {
  if (!audioContext || !mixedAudioDestination || agentStream.getAudioTracks().length === 0) return;
  audioContext.createMediaStreamSource(agentStream).connect(mixedAudioDestination);
}

function wireProviderAgentAudioIntoRecordingMix() {
  if (!providerOutputContext || !audioContext || !mixedAudioDestination) return;
  teardownProviderAgentRecordingTap();
  providerAgentCaptureDestination = providerOutputContext.createMediaStreamDestination();
  providerAgentCaptureIntoMix = audioContext.createMediaStreamSource(providerAgentCaptureDestination.stream);
  providerAgentCaptureIntoMix.connect(mixedAudioDestination);
}

function teardownProviderAgentRecordingTap() {
  providerAgentCaptureIntoMix?.disconnect();
  providerAgentCaptureIntoMix = undefined;
  providerAgentCaptureDestination = undefined;
}

function pickMimeType() {
  const preferredTypes = ["audio/webm;codecs=opus", "audio/webm"];
  return preferredTypes.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function stopAudioRecorders() {
  if (mixedAudioRecorder?.state === "recording" || mixedAudioRecorder?.state === "paused") {
    mixedAudioRecorder.stop();
  }
  audioContext?.close();
  audioContext = undefined;
}

function pauseConversationAudioRecording() {
  isPaymentCollectionActive = true;
  if (mixedAudioRecorder?.state === "recording") {
    mixedAudioRecorder.pause();
    audioPausedAtMs = performance.now();
  }
  log("Conversation audio recording paused for payment collection.");
}

function resumeConversationAudioRecording() {
  if (audioPausedAtMs) {
    totalAudioPausedMs += performance.now() - audioPausedAtMs;
    audioPausedAtMs = undefined;
  }
  if (mixedAudioRecorder?.state === "paused") {
    mixedAudioRecorder.resume();
  }
  isPaymentCollectionActive = false;
  log("Payment transaction approved. Conversation audio recording resumed.");
}

async function finalizeConversation() {
  if (!conversation) return;
  isFinalizingConversation = true;
  setStatus("Saving conversation observability...");
  stopAudioRecorders();
  await waitForRecorderStops();

  conversation.endedAt = new Date().toISOString();
  ensureEvals().totalCallDurationMs = elapsedMs();
  conversation.customerName = [draft.firstName, draft.lastName].filter(Boolean).join(" ") || undefined;
  updateCustomerTranscriptLabels();
  conversation.fullTranscript = buildFullTranscript();
  conversation.finalState = sanitizeFinalState(draft);

  await uploadConversation(conversation);
  await uploadAudio(mixedAudioChunks);
  log(`Conversation observability saved: ${conversation.id}`);
  setStatus("Stopped and saved conversation observability");
  conversation = undefined;
  isFinalizingConversation = false;
}

function waitForRecorderStops() {
  return new Promise((resolve) => {
    setTimeout(resolve, 500);
  });
}

async function uploadConversation(payload) {
  await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function uploadAudio(chunks) {
  if (!conversation || chunks.length === 0) return;

  await fetch(`/api/conversations/${conversation.id}/audio/conversation`, {
    method: "POST",
    headers: { "Content-Type": "audio/webm" },
    body: new Blob(chunks, { type: "audio/webm" }),
  });
}

function sanitizeFinalState(value) {
  const { payment, ...safeValue } = value;
  return {
    ...safeValue,
    payment: payment ? paymentSummary() : undefined,
  };
}

function buildFullTranscript() {
  if (!conversation) return "";
  return conversation.transcripts
    .map((entry) => `${entry.speaker ?? entry.role}: ${entry.text}`)
    .join("\n");
}

function redactToolArgs(name, args) {
  if (name !== "collect_payment_detail") return args;

  return {
    field: args.field,
    value: args.field === "cardNumber" ? `ending in ${String(args.value).replace(/\D/g, "").slice(-4)}` : "captured",
  };
}

function redactSensitiveText(text) {
  return text
    .replace(/\b(?:\d[ -]?){13,19}\b/g, "[card number redacted]")
    .replace(/\b(CVV|cvv|security code)\s*(?:is|:)?\s*\d{3,4}\b/g, "$1 [redacted]");
}

function vehicleSummary() {
  const vehicle = draft.vehicle;
  if (!vehicle) return "not decoded yet";

  const title = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ");
  return [vehicle.vin ? `VIN: ${vehicle.vin}` : undefined, title || undefined].filter(Boolean).join("; ") || "decoded, details unavailable";
}

function geminiFunctionDeclaration(tool) {
  const declaration = {
    name: tool.name,
    description: String(tool.description ?? ""),
  };
  const parameters = coerceGeminiFunctionParameters(tool.parameters);
  if (parameters !== undefined) {
    declaration.parameters = parameters;
  }
  return declaration;
}

/**
 * Omit empty `{}` Gemini declarations when they break setup—but **no-parameters** MUST still declare JSON fields
 * or Gemini often omits/skips invoking generate_quote / save_confirmed_intake reliably.
 */
function coerceGeminiFunctionParameters(parameters) {
  const schema = geminiSchema(parameters);
  if (!schema || typeof schema !== "object") return schema;
  if (isMeaningfulOpenApiLikeSchema(schema)) return schema;
  return {
    type: "object",
    properties: {
      _omit: {
        type: "string",
        description: "Optional; ignore. This tool accepts no meaningful arguments.",
      },
    },
  };
}

function isMeaningfulOpenApiLikeSchema(schema) {
  const props = schema.properties;
  const required = schema.required;
  if (props && typeof props === "object" && Object.keys(props).length > 0) return true;
  if (Array.isArray(required) && required.length > 0) return true;
  return false;
}

function geminiSchema(value) {
  if (Array.isArray(value)) return value.map(geminiSchema);
  if (!value || typeof value !== "object") return value;
  const clean = {};
  Object.entries(value).forEach(([key, entry]) => {
    if (key === "additionalProperties") return;
    if (key === "type" && Array.isArray(entry)) {
      clean[key] = entry[0];
      return;
    }
    clean[key] = geminiSchema(entry);
  });
  return clean;
}

function float32ToBase64Pcm16(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < float32Array.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return arrayBufferToBase64(buffer);
}

function playPcm16Base64(base64, sampleRate) {
  if (!providerOutputContext) return;
  const bytes = base64ToUint8Array(base64);
  playPcm16Bytes(bytes, sampleRate);
}

function playPcm16Bytes(bytes, sampleRate) {
  if (!providerOutputContext) return;
  providerBargeInActive = false;
  providerOutputContext.resume();
  const samples = new Float32Array(bytes.length / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 32768;
  }

  const audioBuffer = providerOutputContext.createBuffer(1, samples.length, sampleRate);
  audioBuffer.copyToChannel(samples, 0);
  const source = providerOutputContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(providerOutputContext.destination);
  if (providerAgentCaptureDestination) {
    source.connect(providerAgentCaptureDestination);
  }
  providerOutputSources.add(source);
  source.addEventListener("ended", () => {
    providerOutputSources.delete(source);
  });
  const startAt = Math.max(providerOutputContext.currentTime, providerOutputCursor);
  recordAgentPlaybackSlice(startAt, audioBuffer.duration);
  source.start(startAt);
  providerOutputCursor = startAt + audioBuffer.duration;
}

function handleProviderBargeIn(samples) {
  if (currentVoiceProvider === "openai" || providerBargeInActive || !providerAudioIsQueued()) return;
  if (rootMeanSquare(samples) < 0.048) return;
  providerBargeInActive = true;
  commitInterruptedProviderAgentTranscripts();
  stopProviderPlayback();
  if (currentVoiceProvider === "grok") {
    sendEvent({ type: "response.cancel" });
  }
  log("User speech detected while Lizzy was talking. Stopped queued provider audio.");
}

function providerAudioIsQueued() {
  if (providerOutputSources.size > 0) return true;
  if (!providerOutputContext) return false;
  return providerOutputCursor - providerOutputContext.currentTime > 0.05;
}

function stopProviderPlayback() {
  providerOutputSources.forEach((source) => {
    try {
      source.stop();
    } catch {
      // Source may already be stopped.
    }
  });
  providerOutputSources.clear();
  if (providerOutputContext) {
    providerOutputCursor = providerOutputContext.currentTime;
  }
  agentAudioActive = false;
  agentResponseStartedAtMs = undefined;
}

function rootMeanSquare(samples) {
  let total = 0;
  for (let i = 0; i < samples.length; i += 1) {
    total += samples[i] * samples[i];
  }
  return Math.sqrt(total / Math.max(samples.length, 1));
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function configurePage() {
  if (callMode === "outbound") {
    modeLabel.textContent = "Outbound call";
    pageTitle.textContent = "Outbound GEICO Quote Call";
    pageDescription.textContent =
      "Mock flow where Lizzy from GEICO is calling the customer to help them get a vehicle insurance quote.";
    return;
  }

  modeLabel.textContent = "Inbound call";
  pageTitle.textContent = "Inbound GEICO Quote Call";
  pageDescription.textContent =
    "Mock flow where the customer called GEICO and Lizzy helps them get a vehicle insurance quote.";
}

function openingInstruction() {
  if (callMode === "outbound") {
    return "Start as an outbound call. Say: Hi, this is Lizzy from GEICO. I am calling to help you get a vehicle insurance quote. Then ask if now is a good time and begin collecting the first missing detail.";
  }

  return "Start as an inbound call. Say: Thank you for calling GEICO, this is Lizzy. I can help you get a vehicle insurance quote today. Then begin collecting the first missing detail.";
}

function log(line) {
  logEl.textContent = `${new Date().toLocaleTimeString()} ${line}\n${logEl.textContent}`;
}

function logOnce(key, line) {
  if (oneTimeLogs.has(key)) return;
  oneTimeLogs.add(key);
  log(line);
}

function setStatus(message) {
  statusEl.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

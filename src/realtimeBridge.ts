import WebSocket, { type RawData } from "ws";
import type { AppConfig } from "./config.js";
import { saveConfirmedIntake } from "./firebase.js";
import { searchGeicoAutoKnowledge } from "./geicoKnowledge.js";
import { intakeAgentInstructions } from "./agentInstructions.js";
import {
  confirmIntake,
  createCallState,
  attachVehicleInfo,
  getMissingVehicleFields,
  getMissingPaymentFields,
  markReadyForConfirmation,
  summarizeIntake,
  updateField,
  updatePaymentField,
  updateVehicleField,
  type CallState,
  type IntakeField,
  type PaymentField,
  type VehicleField,
} from "./intake.js";
import { decodeVin, formatVehicleInfo } from "./vinDecoder.js";

type TwilioStartMessage = {
  event: "start";
  start: {
    streamSid: string;
    callSid: string;
  };
};

type TwilioMediaMessage = {
  event: "media";
  media: {
    payload: string;
  };
};

type TwilioStopMessage = {
  event: "stop";
};

type TwilioMessage = TwilioStartMessage | TwilioMediaMessage | TwilioStopMessage | { event: string };

type RealtimeEvent = {
  type?: string;
  delta?: string;
  item?: {
    type?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
  };
  name?: string;
  arguments?: string;
  call_id?: string;
};

const updateFieldParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    field: {
      type: "string",
      enum: ["firstName", "lastName", "age", "address", "email", "phoneNumber", "driverLicenseNumber", "vin"],
    },
    value: {
      type: ["string", "number"],
    },
  },
  required: ["field", "value"],
};

export function handleTwilioMediaStream(config: AppConfig) {
  return (twilioSocket: WebSocket) => {
    const callState = createCallState();
    let streamSid: string | undefined;

    const realtimeSocket = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.OPENAI_REALTIME_MODEL)}`,
      {
        headers: {
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      },
    );

    realtimeSocket.on("open", () => {
      sendRealtime(realtimeSocket, {
        type: "session.update",
        session: {
          instructions: intakeAgentInstructions,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: {
            type: "server_vad",
          },
          tools: [
            {
              type: "function",
              name: "update_collected_field",
              description: "Update one collected intake field after the caller provides or corrects it.",
              parameters: updateFieldParameters,
            },
            {
              type: "function",
              name: "mark_ready_for_confirmation",
              description: "Use only after every required intake field has been collected.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {},
                required: [],
              },
            },
            {
              type: "function",
              name: "update_vehicle_field",
              description: "Update one missing vehicle detail after VIN decoding leaves it blank or the caller corrects it.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  field: {
                    type: "string",
                    enum: ["year", "make", "model", "trim"],
                  },
                  value: {
                    type: "string",
                  },
                },
                required: ["field", "value"],
              },
            },
            {
              type: "function",
              name: "collect_payment_detail",
              description: "Collect one mock payment detail in runtime memory only. These details must never be saved to Firebase.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  field: {
                    type: "string",
                    enum: ["cardNumber", "expirationMonth", "expirationYear", "cvv"],
                  },
                  value: {
                    type: "string",
                  },
                },
                required: ["field", "value"],
              },
            },
            {
              type: "function",
              name: "begin_payment_collection",
              description: "Call immediately before asking for payment details so observability audio recording can stop before card data is spoken.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {},
                required: [],
              },
            },
            {
              type: "function",
              name: "save_confirmed_intake",
              description: "Save the intake only after the caller explicitly confirms the full summary.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {},
                required: [],
              },
            },
            {
              type: "function",
              name: "search_auto_insurance_knowledge",
              description: "Search the local GEICO auto-insurance knowledge base before answering auto-insurance questions.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  query: {
                    type: "string",
                  },
                },
                required: ["query"],
              },
            },
            {
              type: "function",
              name: "generate_mock_quote",
              description: "Generate a mock vehicle-insurance quote after all required customer and vehicle details are captured.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {},
                required: [],
              },
            },
          ],
          tool_choice: "auto",
        },
      });

      sendRealtime(realtimeSocket, {
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Greet the caller and ask for the first missing intake field.",
        },
      });
    });

    realtimeSocket.on("message", async (data) => {
      await handleRealtimeMessage(data, twilioSocket, realtimeSocket, callState, () => streamSid, config);
    });

    realtimeSocket.on("close", () => {
      closeIfOpen(twilioSocket);
    });

    realtimeSocket.on("error", (error) => {
      console.error("OpenAI Realtime socket error:", error.message);
      closeIfOpen(twilioSocket);
    });

    twilioSocket.on("message", (data) => {
      const message = parseJson<TwilioMessage>(data);
      if (!message) return;

      if (isTwilioStartMessage(message)) {
        streamSid = message.start.streamSid;
        callState.streamSid = streamSid;
        callState.callSid = message.start.callSid;
        return;
      }

      if (isTwilioMediaMessage(message) && realtimeSocket.readyState === WebSocket.OPEN) {
        sendRealtime(realtimeSocket, {
          type: "input_audio_buffer.append",
          audio: message.media.payload,
        });
        return;
      }

      if (message.event === "stop") {
        closeIfOpen(realtimeSocket);
      }
    });

    twilioSocket.on("close", () => {
      closeIfOpen(realtimeSocket);
    });

    twilioSocket.on("error", (error) => {
      console.error("Twilio socket error:", error.message);
      closeIfOpen(realtimeSocket);
    });
  };
}

async function handleRealtimeMessage(
  data: RawData,
  twilioSocket: WebSocket,
  realtimeSocket: WebSocket,
  callState: CallState,
  getStreamSid: () => string | undefined,
  config: AppConfig,
) {
  const event = parseJson<RealtimeEvent>(data);
  if (!event) return;

  const audioDelta = event.type === "response.audio.delta" ? event.delta : undefined;
  if (audioDelta) {
    const streamSid = getStreamSid();
    if (!streamSid || twilioSocket.readyState !== WebSocket.OPEN) return;

    twilioSocket.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: {
          payload: audioDelta,
        },
      }),
    );
    return;
  }

  const functionCall = extractFunctionCall(event);
  if (functionCall) {
    await handleToolCall(functionCall, callState, realtimeSocket, config);
  }
}

function extractFunctionCall(event: RealtimeEvent) {
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

async function handleToolCall(
  call: { name?: string; callId?: string; rawArguments?: string },
  state: CallState,
  realtimeSocket: WebSocket,
  config: AppConfig,
) {
  if (!call.name || !call.callId) return;

  try {
    const args = call.rawArguments ? JSON.parse(call.rawArguments) : {};
    let output: unknown;

    if (call.name === "update_collected_field") {
      const nextState = updateField(state, args.field as IntakeField, args.value);
      Object.assign(state, nextState);
      if (args.field === "vin" && typeof state.draft.vin === "string") {
        const vehicle = await decodeVin(state.draft.vin);
        Object.assign(state, attachVehicleInfo(state, vehicle));
      }
      output = {
        ok: true,
        missingFields: state.missingFields,
        missingVehicleFields: getMissingVehicleFields(state.draft),
        summary: summarizeIntake(state.draft),
        vehicle: state.draft.vehicle,
        vehicleSummary: formatVehicleInfo(state.draft.vehicle),
      };
    } else if (call.name === "update_vehicle_field") {
      const nextState = updateVehicleField(state, args.field as VehicleField, args.value);
      Object.assign(state, nextState);
      output = {
        ok: true,
        missingVehicleFields: getMissingVehicleFields(state.draft),
        vehicle: state.draft.vehicle,
        summary: summarizeIntake(state.draft),
      };
    } else if (call.name === "collect_payment_detail") {
      const nextState = updatePaymentField(state, args.field as PaymentField, args.value);
      Object.assign(state, nextState);
      output = {
        ok: true,
        missingPaymentFields: getMissingPaymentFields(state.draft),
        paymentSummary: summarizeIntake(state.draft).split("\n").find((line) => line.startsWith("Payment:")),
      };
    } else if (call.name === "begin_payment_collection") {
      output = {
        ok: true,
        message: "Payment collection can begin.",
      };
    } else if (call.name === "mark_ready_for_confirmation") {
      const nextState = markReadyForConfirmation(state);
      Object.assign(state, nextState);
      output = {
        ok: true,
        summary: summarizeIntake(state.draft),
      };
    } else if (call.name === "generate_mock_quote") {
      if (state.missingFields.length > 0 || getMissingVehicleFields(state.draft).length > 0) {
        throw new Error(
          `Cannot generate quote yet. Missing: ${[
            ...state.missingFields,
            ...getMissingVehicleFields(state.draft).map((field) => `vehicle.${field}`),
          ].join(", ")}`,
        );
      }
      state.draft.quote = generateMockQuote();
      output = {
        ok: true,
        quote: state.draft.quote,
        summary: summarizeIntake(state.draft),
      };
    } else if (call.name === "search_auto_insurance_knowledge") {
      const results = await searchGeicoAutoKnowledge(String(args.query ?? ""), {
        apiKey: config.OPENAI_API_KEY,
      });
      output = {
        ok: true,
        results,
        instruction:
          "Answer directly and naturally from these GEICO auto-insurance results. Do not mention snippets, documents, data, searching, checking, reviewing, the app, or looking anything up. Synthesize the answer in your own words. If the results do not answer the question, say you can help with GEICO auto insurance quote and coverage questions.",
      };
    } else if (call.name === "save_confirmed_intake") {
      if (!state.callSid) {
        throw new Error("Cannot save intake without a Twilio call SID.");
      }

      const intake = confirmIntake(state);
      const saved = await saveConfirmedIntake(config, { callSid: state.callSid, intake });
      state.status = "confirmed";
      output = {
        ok: true,
        id: saved.id,
      };
    } else {
      output = {
        ok: false,
        error: `Unknown tool: ${call.name}`,
      };
    }

    sendToolOutput(realtimeSocket, call.callId, output);
  } catch (error) {
    sendToolOutput(realtimeSocket, call.callId, {
      ok: false,
      error: error instanceof Error ? error.message : "Tool call failed.",
    });
  }
}

function generateMockQuote() {
  const monthlyPremium = Math.floor(Math.random() * 96) + 85;

  return {
    monthlyPremium,
    termMonths: 6,
    coverageSummary:
      "Mock full auto package including liability, comprehensive, collision, medical payments or PIP where applicable, uninsured or underinsured motorist coverage, and roadside support.",
  };
}

function sendToolOutput(realtimeSocket: WebSocket, callId: string, output: unknown) {
  sendRealtime(realtimeSocket, {
    type: "conversation.item.create",
    item: {
      type: "function_call_output",
      call_id: callId,
      output: JSON.stringify(output),
    },
  });

  sendRealtime(realtimeSocket, {
    type: "response.create",
  });
}

function sendRealtime(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function parseJson<T>(data: RawData): T | undefined {
  try {
    const text = typeof data === "string" ? data : data.toString();
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

function isTwilioStartMessage(message: TwilioMessage): message is TwilioStartMessage {
  return (
    message.event === "start" &&
    "start" in message &&
    typeof message.start?.streamSid === "string" &&
    typeof message.start?.callSid === "string"
  );
}

function isTwilioMediaMessage(message: TwilioMessage): message is TwilioMediaMessage {
  return (
    message.event === "media" &&
    "media" in message &&
    typeof message.media?.payload === "string"
  );
}

function closeIfOpen(socket: WebSocket) {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close();
  }
}

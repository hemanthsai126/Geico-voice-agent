import type { Request, Response } from "express";
import type { AppConfig } from "./config.js";
import { saveConfirmedIntake } from "./firebase.js";
import { searchGeicoAutoKnowledge } from "./geicoKnowledge.js";
import { intakeAgentInstructions } from "./agentInstructions.js";
import { parseConfirmedIntake } from "./intake.js";
import { decodeVin } from "./vinDecoder.js";

const tools = [
  {
    type: "function",
    name: "update_collected_field",
    description: "Update one collected intake field after the user provides or corrects it.",
    parameters: {
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
    },
  },
  {
    type: "function",
    name: "update_vehicle_field",
    description: "Update one missing vehicle detail after VIN decoding leaves it blank or the user corrects it.",
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
    name: "save_confirmed_intake",
    description: "Save the intake only after the user explicitly confirms the full summary.",
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
];

export function handleBrowserRealtimeToken(config: AppConfig) {
  return async (req: Request, res: Response) => {
    try {
      const mode = req.query.mode === "outbound" ? "outbound" : "inbound";
      const requestedProvider = String(req.query.provider ?? config.VOICE_MODEL_PROVIDER);
      const provider = requestedProvider === "grok" || requestedProvider === "gemini" ? requestedProvider : "openai";
      const model = String(req.query.model ?? modelForProvider(config, provider));

      if (provider !== "openai") {
        res.json({
          provider,
          model,
          websocketPath: `/api/provider-realtime?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`,
          instructions: `${intakeAgentInstructions}\n\nCall mode: ${mode}.`,
          tools,
          audio: provider === "gemini" ? { inputRate: 16000, outputRate: 24000 } : { inputRate: 24000, outputRate: 24000 },
        });
        return;
      }

      const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          expires_after: {
            anchor: "created_at",
            seconds: 600,
          },
          session: {
            type: "realtime",
            model,
            instructions: `${intakeAgentInstructions}\n\nCall mode: ${mode}.`,
            audio: {
              input: {
                transcription: {
                  model: "whisper-1",
                },
                turn_detection: {
                  type: "server_vad",
                  create_response: true,
                },
              },
              output: {
                voice: "marin",
              },
            },
            tools,
          },
        }),
      });

      const data = (await response.json()) as Record<string, unknown>;

      if (!response.ok) {
        res.status(response.status).json({
          error: "Failed to create OpenAI Realtime token.",
          details: data,
        });
        return;
      }

      res.json({
        ...data,
        provider,
        model,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "Failed to create OpenAI Realtime token.",
      });
    }
  };
}

function openAiVoiceOptionLabel(model: string): string {
  if (model === "gpt-realtime-2") return "OpenAI · GPT Realtime 2";
  return `OpenAI ${model}`;
}

export function handleVoiceModelOptions(config: AppConfig) {
  return (_req: Request, res: Response) => {
    res.json({
      defaultProvider: config.VOICE_MODEL_PROVIDER,
      options: [
        {
          provider: "openai",
          model: config.OPENAI_REALTIME_MODEL,
          label: openAiVoiceOptionLabel(config.OPENAI_REALTIME_MODEL),
          available: true,
        },
        {
          provider: "grok",
          model: config.GROK_VOICE_MODEL,
          label: `Grok ${config.GROK_VOICE_MODEL}`,
          available: Boolean(config.GROK_API_KEY),
          note: config.GROK_API_KEY ? "Runs through the xAI realtime voice adapter." : "Add GROK_API_KEY to enable.",
        },
        {
          provider: "gemini",
          model: config.GEMINI_VOICE_MODEL,
          label: `Gemini ${config.GEMINI_VOICE_MODEL}`,
          available: Boolean(config.GEMINI_API_KEY),
          note: config.GEMINI_API_KEY ? "Runs through the Gemini Live adapter." : "Add GEMINI_API_KEY to enable.",
        },
      ],
    });
  };
}

function modelForProvider(config: AppConfig, provider: "openai" | "grok" | "gemini") {
  if (provider === "grok") return config.GROK_VOICE_MODEL;
  if (provider === "gemini") return config.GEMINI_VOICE_MODEL;
  return config.OPENAI_REALTIME_MODEL;
}

export function handleKnowledgeSearch(config: AppConfig) {
  return async (req: Request, res: Response) => {
    try {
      const query = String(req.body?.query ?? "");
      const results = await searchGeicoAutoKnowledge(query, {
        apiKey: config.OPENAI_API_KEY,
      });

      res.json({
        ok: true,
        results,
      });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to search GEICO knowledge.",
      });
    }
  };
}

export function handleBrowserSaveIntake(config: AppConfig) {
  return async (req: Request, res: Response) => {
    try {
      const intake = parseConfirmedIntake(req.body?.intake ?? req.body);
      const result = await saveConfirmedIntake(config, {
        callSid: `browser-${crypto.randomUUID()}`,
        intake,
      });

      res.json({
        ok: true,
        id: result.id,
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save intake.",
      });
    }
  };
}

export function handleVinDecode() {
  return async (req: Request, res: Response) => {
    try {
      const vin = String(req.body?.vin ?? "");
      const vehicle = await decodeVin(vin);

      res.json({
        ok: true,
        vehicle,
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to decode VIN.",
      });
    }
  };
}

import type { Request, Response } from "express";
import type { AppConfig } from "./config.js";
import { buildRealtimeIntakeInstructions, type VoiceCallMode } from "./prompts/index.js";
import { saveConfirmedIntake } from "./firebase.js";
import { searchGeicoAutoKnowledge } from "./geicoKnowledge.js";
import { parseConfirmedIntake } from "./intake.js";
import { realtimeIntakeTools } from "./realtimeTools.js";
import { decodeVin } from "./vinDecoder.js";

const tools = realtimeIntakeTools.map((tool) =>
  structuredClone(tool as unknown as Record<string, unknown>),
) as unknown[];

function voiceCallModeFromRequest(req: Request, config: AppConfig): VoiceCallMode {
  const raw = typeof req.query.mode === "string" ? req.query.mode.trim().toLowerCase() : "";
  if (raw === "outbound") return "outbound";
  if (raw === "inbound") return "inbound";
  return config.CALL_MODE;
}

/** Browser combines this with `window.location` unless it is already an absolute `wss:` URL. */
function providerRealtimeBrowserPath(config: AppConfig, provider: string, model: string): string {
  const qs = `provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`;
  const path = `/api/provider-realtime?${qs}`;
  if (config.PROVIDER_REALTIME_WS_ORIGIN) {
    const u = new URL(path, config.PROVIDER_REALTIME_WS_ORIGIN);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.toString();
  }
  return path;
}

function grokGeminiBlockedOnVercelWithoutRelay(config: AppConfig): boolean {
  return process.env.VERCEL === "1" && !config.PROVIDER_REALTIME_WS_ORIGIN;
}

export function handleBrowserRealtimeToken(config: AppConfig) {
  return async (req: Request, res: Response) => {
    try {
      const mode = voiceCallModeFromRequest(req, config);
      const requestedProvider = String(req.query.provider ?? config.VOICE_MODEL_PROVIDER);
      const provider = requestedProvider === "grok" || requestedProvider === "gemini" ? requestedProvider : "openai";
      const model = String(req.query.model ?? modelForProvider(config, provider));
      const instructions = buildRealtimeIntakeInstructions(mode, { provider, model });

      if (provider !== "openai") {
        if (grokGeminiBlockedOnVercelWithoutRelay(config)) {
          res.status(503).json({
            error:
              "Grok and Gemini realtime need WebSockets. On Vercel, set PROVIDER_REALTIME_WS_ORIGIN to an HTTPS origin that runs this server with WS enabled (same codebase on Railway/Render/Fly), or use OpenAI in the browser.",
          });
          return;
        }

        res.json({
          provider,
          model,
          websocketPath: providerRealtimeBrowserPath(config, provider, model),
          instructions,
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
            instructions,
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
    const relayBlocked = grokGeminiBlockedOnVercelWithoutRelay(config);
    const grokNote = relayBlocked
      ? "On Vercel: set PROVIDER_REALTIME_WS_ORIGIN to a WS-capable deployment of this app, or use OpenAI."
      : config.GROK_API_KEY
        ? "Runs through the xAI realtime voice adapter."
        : "Add GROK_API_KEY to enable.";
    const geminiNote = relayBlocked
      ? "On Vercel: set PROVIDER_REALTIME_WS_ORIGIN to a WS-capable deployment of this app, or use OpenAI."
      : config.GEMINI_API_KEY
        ? "Runs through the Gemini Live adapter."
        : "Add GEMINI_API_KEY to enable.";

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
          available: Boolean(config.GROK_API_KEY) && !relayBlocked,
          note: grokNote,
        },
        {
          provider: "gemini",
          model: config.GEMINI_VOICE_MODEL,
          label: `Gemini ${config.GEMINI_VOICE_MODEL}`,
          available: Boolean(config.GEMINI_API_KEY) && !relayBlocked,
          note: geminiNote,
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

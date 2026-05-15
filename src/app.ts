import express from "express";
import { join } from "node:path";
import {
  handleBrowserRealtimeToken,
  handleBrowserSaveIntake,
  handleKnowledgeSearch,
  handleVinDecode,
  handleVoiceModelOptions,
} from "./browserRealtime.js";
import type { AppConfig } from "./config.js";
import {
  conversationAudioBodyParser,
  handleGetConversation,
  handleGetConversationAudio,
  handleListConversations,
  handleSaveConversation,
  handleSaveConversationAudio,
} from "./observability.js";
import { handleTwilioVoice } from "./twilio.js";

/** Shared Express app (local Node server + Vercel serverless). */
export function createApp(config: AppConfig) {
  const app = express();

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use(express.static(join(process.cwd(), "public")));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/twilio/voice", handleTwilioVoice(config));
  app.get("/api/realtime/models", handleVoiceModelOptions(config));
  app.get("/api/realtime/token", handleBrowserRealtimeToken(config));
  app.post("/api/browser-intake", handleBrowserSaveIntake(config));
  app.post("/api/vin/decode", handleVinDecode());
  app.post("/api/geico/search", handleKnowledgeSearch(config));
  app.post("/api/conversations", handleSaveConversation(config));
  app.post("/api/conversations/:id/audio/:track", express.raw(conversationAudioBodyParser()), handleSaveConversationAudio(config));
  app.get("/api/conversations", handleListConversations(config));
  app.get("/api/conversations/:id", handleGetConversation(config));
  app.get("/api/conversations/:id/audio/:track", handleGetConversationAudio(config));
  app.get(["/inbound", "/outbound"], (_req, res) => {
    res.sendFile(join(process.cwd(), "public", "call.html"));
  });
  app.get("/conversations", (_req, res) => {
    res.sendFile(join(process.cwd(), "public", "conversations.html"));
  });
  app.get(["/evals", "/evals/openai", "/evals/grok", "/evals/gemini"], (_req, res) => {
    res.sendFile(join(process.cwd(), "public", "evals.html"));
  });
  app.get(["/rag-analysis", "/rag-analysis/openai", "/rag-analysis/grok", "/rag-analysis/gemini"], (_req, res) => {
    res.sendFile(join(process.cwd(), "public", "rag-analysis.html"));
  });
  app.get("/evals/conversation", (_req, res) => {
    res.sendFile(join(process.cwd(), "public", "eval-conversation.html"));
  });

  return app;
}

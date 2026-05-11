import express from "express";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import {
  handleBrowserRealtimeToken,
  handleBrowserSaveIntake,
  handleKnowledgeSearch,
  handleVinDecode,
  handleVoiceModelOptions,
} from "./browserRealtime.js";
import { loadConfig } from "./config.js";
import {
  conversationAudioBodyParser,
  handleGetConversation,
  handleGetConversationAudio,
  handleListConversations,
  handleSaveConversation,
  handleSaveConversationAudio,
} from "./observability.js";
import { createProviderRealtimeServer } from "./providerRealtime.js";
import { handleTwilioMediaStream } from "./realtimeBridge.js";
import { handleTwilioVoice } from "./twilio.js";

const config = loadConfig();
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static("public"));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/twilio/voice", handleTwilioVoice(config));
app.get("/api/realtime/models", handleVoiceModelOptions(config));
app.get("/api/realtime/token", handleBrowserRealtimeToken(config));
app.post("/api/browser-intake", handleBrowserSaveIntake(config));
app.post("/api/vin/decode", handleVinDecode());
app.post("/api/geico/search", handleKnowledgeSearch(config));
app.post("/api/conversations", handleSaveConversation());
app.post("/api/conversations/:id/audio/:track", express.raw(conversationAudioBodyParser()), handleSaveConversationAudio());
app.get("/api/conversations", handleListConversations());
app.get("/api/conversations/:id", handleGetConversation());
app.get("/api/conversations/:id/audio/:track", handleGetConversationAudio());
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

const server = createServer(app);
const mediaStreamServer = new WebSocketServer({ noServer: true });
const providerRealtimeServer = createProviderRealtimeServer(config);

mediaStreamServer.on("connection", handleTwilioMediaStream(config));

server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (pathname === "/twilio/media-stream") {
    mediaStreamServer.handleUpgrade(request, socket, head, (websocket) => {
      mediaStreamServer.emit("connection", websocket, request);
    });
    return;
  }

  if (pathname === "/api/provider-realtime") {
    providerRealtimeServer.handleUpgrade(request, socket, head);
    return;
  }

  socket.destroy();
});

server.listen(config.PORT, () => {
  console.log(`Voice intake agent listening on port ${config.PORT}`);
});

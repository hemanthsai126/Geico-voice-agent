import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type { AppConfig } from "./config.js";

export function createProviderRealtimeServer(config: AppConfig) {
  const server = new WebSocketServer({ noServer: true });

  server.on("connection", (client, request) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const provider = url.searchParams.get("provider");
    const model = url.searchParams.get("model") ?? "";
    const pendingMessages: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
    let upstream: WebSocket;

    try {
      upstream = createUpstreamSocket(config, provider, model);
    } catch (error) {
      client.send(
        JSON.stringify({
          type: "provider.error",
          error: error instanceof Error ? error.message : "Provider realtime connection failed.",
        }),
      );
      client.close(1011, "provider setup failed");
      return;
    }

    upstream.on("open", () => {
      console.log(`Provider realtime connected: ${provider} ${model}`);
      client.send(JSON.stringify({ type: "provider.open", provider, model }));
      pendingMessages.splice(0).forEach((message) => {
        upstream.send(message.data, { binary: message.isBinary });
      });
    });

    upstream.on("message", (data, isBinary) => {
      if (provider === "gemini") {
        const text = data.toString();
        if (text.trim().startsWith("{")) {
          if (text.includes("setupComplete") || text.includes("error") || text.includes("goAway")) {
            console.log(`Provider realtime message (${provider}): ${text.slice(0, 500)}`);
          }
          if (client.readyState === WebSocket.OPEN) {
            client.send(text);
          }
          return;
        }
      } else if (!isBinary) {
        const text = data.toString();
        if (text.includes("setupComplete") || text.includes("error") || text.includes("goAway")) {
          console.log(`Provider realtime message (${provider}): ${text.slice(0, 500)}`);
        }
      }
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });

    upstream.on("error", (error) => {
      console.error(`Provider realtime error (${provider}):`, error);
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: "provider.error",
            error: error instanceof Error ? error.message : "Provider realtime connection failed.",
          }),
        );
      }
    });

    upstream.on("close", (code, reason) => {
      console.log(`Provider realtime closed: ${provider} ${code} ${reason.toString()}`);
      if (client.readyState === WebSocket.OPEN) {
        client.close(code || 1000, reason.toString() || "provider closed");
      }
    });

    client.on("message", (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
        return;
      }
      pendingMessages.push({ data, isBinary });
    });

    client.on("close", () => {
      upstream.close();
    });
  });

  return {
    handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
      server.handleUpgrade(request, socket, head, (websocket) => {
        server.emit("connection", websocket, request);
      });
    },
  };
}

function createUpstreamSocket(config: AppConfig, provider: string | null, model: string) {
  if (provider === "grok") {
    if (!config.GROK_API_KEY) {
      throw new Error("GROK_API_KEY is not configured.");
    }
    return new WebSocket(`wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model || config.GROK_VOICE_MODEL)}`, {
      headers: {
        Authorization: `Bearer ${config.GROK_API_KEY}`,
      },
    });
  }

  if (provider === "gemini") {
    if (!config.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not configured.");
    }
    return new WebSocket(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(config.GEMINI_API_KEY)}`,
    );
  }

  throw new Error(`Unsupported provider: ${provider ?? "unknown"}`);
}

import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createProviderRealtimeServer } from "./providerRealtime.js";
import { handleTwilioMediaStream } from "./realtimeBridge.js";

const config = loadConfig();
const app = createApp(config);

if (!process.env.VERCEL) {
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
}

import type { Request, Response } from "express";
import type { AppConfig } from "./config.js";

function twilioMediaStreamWsUrl(config: AppConfig): string {
  if (config.TWILIO_MEDIA_STREAM_WS_URL) {
    return config.TWILIO_MEDIA_STREAM_WS_URL;
  }
  const mediaStreamUrl = new URL("/twilio/media-stream", config.PUBLIC_BASE_URL);
  mediaStreamUrl.protocol = mediaStreamUrl.protocol === "https:" ? "wss:" : "ws:";
  return mediaStreamUrl.toString();
}

export function handleTwilioVoice(config: AppConfig) {
  return (_req: Request, res: Response) => {
    const streamWs = twilioMediaStreamWsUrl(config);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Thank you for calling. I will collect your intake information now.</Say>
  <Connect>
    <Stream url="${streamWs}" />
  </Connect>
</Response>`;

    res.type("text/xml").send(twiml);
  };
}

/**
 * Vercel serverless entry: HTTP-only Express app (no WebSocket upgrades).
 * See docs/VERCEL.md for Grok/Gemini relay and Twilio media stream env vars.
 */
import serverless from "serverless-http";
import { createApp } from "../dist/src/app.js";
import { loadConfig } from "../dist/src/config.js";

const config = loadConfig();
const app = createApp(config);

export default serverless(app);

/**
 * Vercel serverless entry: exports the Express app directly.
 * Vercel's Node.js runtime passes the original req.url, so no path-restore middleware needed.
 * See docs/VERCEL.md for Grok/Gemini relay and Twilio media stream env vars.
 */
import { createApp } from "../dist/src/app.js";
import { loadConfig } from "../dist/src/config.js";

const config = loadConfig();
const app = createApp(config);

export default app;

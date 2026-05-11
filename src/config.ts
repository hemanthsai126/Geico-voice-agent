import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url(),
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_REALTIME_MODEL: z.string().min(1).default("gpt-realtime-2"),
  VOICE_MODEL_PROVIDER: z.enum(["openai", "grok", "gemini"]).default("openai"),
  GROK_API_KEY: z.string().min(1).optional(),
  GROK_VOICE_MODEL: z.string().min(1).default("grok-voice-think-fast-1.0"),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_VOICE_MODEL: z.string().min(1).default("gemini-3.1-flash-live-preview"),
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().email().optional(),
  FIREBASE_PRIVATE_KEY: z.string().min(1).optional(),
  FIRESTORE_COLLECTION: z.string().min(1).default("voiceIntakeLeads"),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");

    throw new Error(`Invalid environment configuration: ${details}`);
  }

  return {
    ...parsed.data,
    FIREBASE_PRIVATE_KEY: parsed.data.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  };
}

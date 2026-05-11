import type { Request, Response } from "express";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

type ConversationSummary = {
  id: string;
  startedAt: string;
  endedAt?: string;
  mode?: string;
  voiceModel?: {
    provider?: string;
    model?: string;
  };
  customerName?: string;
  transcriptCount: number;
  toolCallCount: number;
};

const conversationsRoot = resolve(process.cwd(), "Observability", "conversations");

export function conversationAudioBodyParser() {
  return {
    type: ["audio/webm", "audio/*", "application/octet-stream"],
    limit: "100mb",
  };
}

export function handleSaveConversation() {
  return async (req: Request, res: Response) => {
    try {
      const conversation = req.body;
      const id = sanitizeId(conversation?.id);
      const conversationDir = await ensureConversationDir(id);
      const cleanConversation = sanitizeConversation(conversation, id);

      await writeFile(join(conversationDir, "conversation.json"), JSON.stringify(cleanConversation, null, 2), "utf-8");

      res.json({
        ok: true,
        id,
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save conversation.",
      });
    }
  };
}

export function handleSaveConversationAudio() {
  return async (req: Request, res: Response) => {
    try {
      const id = sanitizeId(req.params.id);
      const track = sanitizeTrack(req.params.track);
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);

      if (body.length === 0) {
        throw new Error("Audio body is empty.");
      }

      const conversationDir = await ensureConversationDir(id);
      const fileName = `${track}.webm`;
      await writeFile(join(conversationDir, fileName), body);

      res.json({
        ok: true,
        file: fileName,
        bytes: body.length,
      });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save conversation audio.",
      });
    }
  };
}

export function handleListConversations() {
  return async (_req: Request, res: Response) => {
    await mkdir(conversationsRoot, { recursive: true });
    const ids = await readdir(conversationsRoot);
    const summaries = await Promise.all(ids.map(readConversationSummary));

    res.json({
      ok: true,
      conversations: summaries
        .filter((summary): summary is ConversationSummary => Boolean(summary))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    });
  };
}

export function handleGetConversation() {
  return async (req: Request, res: Response) => {
    try {
      const id = sanitizeId(req.params.id);
      const conversationPath = join(conversationsRoot, id, "conversation.json");
      const conversation = JSON.parse(await readFile(conversationPath, "utf-8"));

      res.json({
        ok: true,
        conversation,
        audio: {
          conversation: `/api/conversations/${id}/audio/conversation`,
        },
      });
    } catch (error) {
      res.status(404).json({
        ok: false,
        error: error instanceof Error ? error.message : "Conversation not found.",
      });
    }
  };
}

export function handleGetConversationAudio() {
  return async (req: Request, res: Response) => {
    try {
      const id = sanitizeId(req.params.id);
      const track = sanitizeTrack(req.params.track);
      const audioPath = join(conversationsRoot, id, `${track}.webm`);

      if (!existsSync(audioPath)) {
        res.status(404).json({ ok: false, error: "Audio not found." });
        return;
      }

      res.type("audio/webm").sendFile(audioPath);
    } catch (error) {
      res.status(404).json({
        ok: false,
        error: error instanceof Error ? error.message : "Audio not found.",
      });
    }
  };
}

async function ensureConversationDir(id: string) {
  const conversationDir = join(conversationsRoot, id);
  await mkdir(conversationDir, { recursive: true });
  return conversationDir;
}

async function readConversationSummary(id: string): Promise<ConversationSummary | undefined> {
  try {
    const conversation = JSON.parse(await readFile(join(conversationsRoot, id, "conversation.json"), "utf-8"));
    return {
      id,
      startedAt: conversation.startedAt,
      endedAt: conversation.endedAt,
      mode: conversation.mode,
      voiceModel: conversation.voiceModel,
      customerName: conversation.customerName,
      transcriptCount: conversation.transcripts?.length ?? 0,
      toolCallCount: conversation.toolCalls?.length ?? 0,
    };
  } catch {
    return undefined;
  }
}

function sanitizeConversation(conversation: unknown, id: string) {
  const value = typeof conversation === "object" && conversation ? (conversation as Record<string, unknown>) : {};

  return {
    ...value,
    id,
    payment: undefined,
  };
}

function sanitizeId(value: unknown) {
  const id = String(value ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) {
    throw new Error("Conversation id is required.");
  }
  return id;
}

function sanitizeTrack(value: unknown) {
  const track = String(value ?? "");
  if (track !== "conversation" && track !== "user" && track !== "agent") {
    throw new Error("Audio track must be conversation.");
  }
  return track;
}

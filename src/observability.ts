import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { Request, Response } from "express";
import type { AppConfig } from "./config.js";
import { initializeFirebase } from "./firebase.js";

const CONVERSATIONS_COLLECTION = "conversations";

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

export function conversationAudioBodyParser() {
  return {
    type: ["audio/webm", "audio/*", "application/octet-stream"],
    limit: "100mb",
  };
}

export function handleSaveConversation(config: AppConfig) {
  return async (req: Request, res: Response) => {
    try {
      initializeFirebase(config);
      const db = getFirestore();
      const conversation = req.body;
      const id = sanitizeId(conversation?.id);
      const clean = sanitizeConversation(conversation, id);

      await db.collection(CONVERSATIONS_COLLECTION).doc(id).set(clean);

      res.json({ ok: true, id });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save conversation.",
      });
    }
  };
}

export function handleSaveConversationAudio(config: AppConfig) {
  return async (req: Request, res: Response) => {
    try {
      initializeFirebase(config);
      const id = sanitizeId(req.params.id);
      const track = sanitizeTrack(req.params.track);
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from([]);

      if (body.length === 0) {
        throw new Error("Audio body is empty.");
      }

      const bucket = getStorage().bucket();
      const file = bucket.file(`conversations/${id}/${track}.webm`);
      await file.save(body, { contentType: "audio/webm", resumable: false });

      res.json({ ok: true, file: `${track}.webm`, bytes: body.length });
    } catch (error) {
      res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to save conversation audio.",
      });
    }
  };
}

export function handleListConversations(config: AppConfig) {
  return async (_req: Request, res: Response) => {
    try {
      initializeFirebase(config);
      const db = getFirestore();
      const snapshot = await db
        .collection(CONVERSATIONS_COLLECTION)
        .orderBy("startedAt", "desc")
        .limit(200)
        .get();

      const conversations: ConversationSummary[] = snapshot.docs.map((doc) => {
        const data = doc.data();
        return {
          id: doc.id,
          startedAt: data.startedAt ?? "",
          endedAt: data.endedAt,
          mode: data.mode,
          voiceModel: data.voiceModel,
          customerName: data.customerName,
          transcriptCount: Array.isArray(data.transcripts) ? data.transcripts.length : 0,
          toolCallCount: Array.isArray(data.toolCalls) ? data.toolCalls.length : 0,
        };
      });

      res.json({ ok: true, conversations });
    } catch (error) {
      res.status(500).json({
        ok: false,
        error: error instanceof Error ? error.message : "Failed to list conversations.",
      });
    }
  };
}

export function handleGetConversation(config: AppConfig) {
  return async (req: Request, res: Response) => {
    try {
      initializeFirebase(config);
      const db = getFirestore();
      const id = sanitizeId(req.params.id);
      const doc = await db.collection(CONVERSATIONS_COLLECTION).doc(id).get();

      if (!doc.exists) {
        res.status(404).json({ ok: false, error: "Conversation not found." });
        return;
      }

      res.json({
        ok: true,
        conversation: doc.data(),
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

export function handleGetConversationAudio(config: AppConfig) {
  return async (req: Request, res: Response) => {
    try {
      initializeFirebase(config);
      const id = sanitizeId(req.params.id);
      const track = sanitizeTrack(req.params.track);

      const bucket = getStorage().bucket();
      const file = bucket.file(`conversations/${id}/${track}.webm`);
      const [exists] = await file.exists();

      if (!exists) {
        res.status(404).json({ ok: false, error: "Audio not found." });
        return;
      }

      res.setHeader("Content-Type", "audio/webm");
      file.createReadStream().pipe(res);
    } catch (error) {
      res.status(404).json({
        ok: false,
        error: error instanceof Error ? error.message : "Audio not found.",
      });
    }
  };
}

function sanitizeConversation(conversation: unknown, id: string) {
  const value =
    typeof conversation === "object" && conversation
      ? (conversation as Record<string, unknown>)
      : {};

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
    throw new Error("Audio track must be conversation, user, or agent.");
  }
  return track;
}

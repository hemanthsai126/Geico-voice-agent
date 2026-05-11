import { cert, getApps, initializeApp, applicationDefault } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import type { AppConfig } from "./config.js";
import type { ConfirmedIntake } from "./intake.js";

export type SaveIntakeInput = {
  callSid: string;
  intake: ConfirmedIntake;
};

export function initializeFirebase(config: AppConfig) {
  if (getApps().length === 0) {
    initializeApp({
      credential:
        config.FIREBASE_CLIENT_EMAIL && config.FIREBASE_PRIVATE_KEY
          ? cert({
              projectId: config.FIREBASE_PROJECT_ID,
              clientEmail: config.FIREBASE_CLIENT_EMAIL,
              privateKey: config.FIREBASE_PRIVATE_KEY,
            })
          : applicationDefault(),
      projectId: config.FIREBASE_PROJECT_ID,
    });
  }

  return getFirestore();
}

export function buildIntakeRecord({ callSid, intake }: SaveIntakeInput) {
  return {
    ...intake,
    status: "confirmed" as const,
    twilioCallSid: callSid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

export async function saveConfirmedIntake(config: AppConfig, input: SaveIntakeInput) {
  const db = initializeFirebase(config);
  const record = buildIntakeRecord(input);
  const ref = await db.collection(config.FIRESTORE_COLLECTION).add(record);

  return {
    id: ref.id,
    record,
  };
}

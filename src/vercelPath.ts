import type { NextFunction, Request, Response } from "express";

/**
 * Vercel `rewrites` send traffic to `/api` with the real path in `?__p=...` (see `vercel.json`).
 * Without this, Express only ever sees `/api` and page links like `/inbound` never match.
 */
export function vercelRestorePathMiddleware(req: Request, _res: Response, next: NextFunction) {
  if (process.env.VERCEL !== "1") {
    next();
    return;
  }

  try {
    const full = req.url ?? "/";
    const base = full.startsWith("http") ? new URL(full) : new URL(full, "http://vercel.internal");
    const raw = base.searchParams.get("__p");

    if (raw === null) {
      next();
      return;
    }

    base.searchParams.delete("__p");

    if (raw.includes("..")) {
      req.url = "/" + (base.search || "");
      next();
      return;
    }

    const path = raw === "" ? "/" : `/${raw}`.replace(/\/{2,}/g, "/");
    req.url = path + (base.search || "");
  } catch {
    /* keep req.url */
  }

  next();
}

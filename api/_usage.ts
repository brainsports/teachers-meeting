/**
 * Shared server-side daily usage limiting for teachers-meeting APIs.
 * Structure reused from brainsports/meeting — api/_lib.ts (in-memory
 * usage store keyed by userId_KST-date), adapted to a 3/day limit.
 *
 * NOTE: in-memory per serverless instance (same tradeoff as meeting).
 * Users are identified by client IP when no token exists — identical
 * model to the meeting project's direct-Vercel-access fallback.
 */
import type { VercelRequest } from "@vercel/node";

export const DAILY_LIMIT = 3;

interface UsageRecord {
  usageCount: number;
  limit: number;
}

// In-memory usage store (keyed by userId_KST-date), reset on cold start
const usageStore: Record<string, UsageRecord> = {};

// Current date key in Korea Standard Time (UTC+9), e.g. "2026-09-10"
export function getKstDateKey(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

// Resolve a stable per-user id from the request (IP fallback, same as meeting)
export function resolveUserId(req: VercelRequest): string {
  const fwd = (req.headers["x-forwarded-for"] as string) || "";
  return "ip:" + (fwd.split(",")[0].trim() || req.socket?.remoteAddress || "unknown");
}

export function getUserUsage(userId: string) {
  const key = `${userId}_${getKstDateKey()}`;
  if (!usageStore[key]) {
    usageStore[key] = { usageCount: 0, limit: DAILY_LIMIT };
  }
  const rec = usageStore[key];
  const remaining = Math.max(0, rec.limit - rec.usageCount);
  return { usageCount: rec.usageCount, limit: rec.limit, remaining };
}

// Called ONLY after a successful generation
export function incrementUserUsage(userId: string) {
  const key = `${userId}_${getKstDateKey()}`;
  if (!usageStore[key]) {
    usageStore[key] = { usageCount: 0, limit: DAILY_LIMIT };
  }
  usageStore[key].usageCount += 1;
  return getUserUsage(userId);
}

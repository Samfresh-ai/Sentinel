import crypto from "node:crypto";
import type { Request } from "express";

export function verifySlackSignature(req: Request, rawBody: Buffer): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) return false;
  const timestamp = req.header("x-slack-request-timestamp");
  const signature = req.header("x-slack-signature");
  if (!timestamp || !signature) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - Number.parseInt(timestamp, 10));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;
  const base = `v0:${timestamp}:${rawBody.toString("utf8")}`;
  const digest = `v0=${crypto.createHmac("sha256", signingSecret).update(base).digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

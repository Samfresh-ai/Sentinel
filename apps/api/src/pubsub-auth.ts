import { OAuth2Client } from "google-auth-library";
import type { Request } from "express";

let oauthClient: OAuth2Client | undefined;

function client(): OAuth2Client {
  if (!oauthClient) {
    oauthClient = new OAuth2Client();
  }
  return oauthClient;
}

function booleanEnv(name: string): boolean {
  return process.env[name]?.toLowerCase() === "true";
}

export async function verifyPubSubPushAuth(req: Request): Promise<void> {
  const audience = process.env.PUBSUB_PUSH_AUDIENCE;
  const serviceAccount = process.env.PUBSUB_PUSH_SERVICE_ACCOUNT;
  const authRequired = booleanEnv("PUBSUB_PUSH_AUTH_REQUIRED");

  if (!audience && !serviceAccount) {
    if (authRequired) {
      const error = new Error("PUBSUB_PUSH_AUDIENCE and PUBSUB_PUSH_SERVICE_ACCOUNT are required when PUBSUB_PUSH_AUTH_REQUIRED=true");
      error.name = "Unauthorized";
      throw error;
    }
    return;
  }

  if (!audience) {
    throw new Error("PUBSUB_PUSH_AUDIENCE is required when Pub/Sub push authentication is configured");
  }

  const authorization = req.header("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    const error = new Error("Missing Pub/Sub push bearer token");
    error.name = "Unauthorized";
    throw error;
  }

  const ticket = await client().verifyIdToken({
    idToken: match[1],
    audience
  });
  const payload = ticket.getPayload();
  if (!payload) {
    const error = new Error("Pub/Sub push token has no payload");
    error.name = "Unauthorized";
    throw error;
  }
  if (serviceAccount && payload.email !== serviceAccount) {
    const error = new Error("Pub/Sub push token service account mismatch");
    error.name = "Unauthorized";
    throw error;
  }
}

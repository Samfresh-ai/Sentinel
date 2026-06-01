import bcrypt from "bcryptjs";
import { createCollection, createKvKey, getDocument, insertDocument, queryDocuments, updateDocument } from "@sentinel/splunk-brain";

export const SEED_ORG_ID = process.env.SEED_ORG_ID ?? process.env.OPERAIQ_ORG_ID ?? "operaiq-local-org";
export const SEED_ORG_NAME = process.env.SEED_ORG_NAME ?? "OperaIQ Demo";
export const SEED_ADMIN_EMAIL = (process.env.SEED_ADMIN_EMAIL ?? "demo@operaiq.local").toLowerCase();
export const SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "operaiq-demo-password";
export const SEED_WEBHOOK_SECRET = process.env.SEED_WEBHOOK_SECRET ?? "operaiq-demo-webhook-secret";

export async function ensureSeedOrg(): Promise<{ orgId: string; orgName: string; adminEmail: string; webhookSecret: string }> {
  await createCollection("orgs", {});
  await createCollection("users", {});
  const now = new Date().toISOString();
  const webhookSecretHash = await bcrypt.hash(SEED_WEBHOOK_SECRET, 12);
  const existingOrg = await getDocument<Record<string, unknown>>("orgs", SEED_ORG_ID).catch(() => null);
  if (existingOrg) {
    await updateDocument("orgs", SEED_ORG_ID, {
      orgName: SEED_ORG_NAME,
      adminEmail: SEED_ADMIN_EMAIL,
      webhookSecretHash,
      updatedAt: now
    });
  } else {
    await insertDocument("orgs", {
      _key: SEED_ORG_ID,
      orgName: SEED_ORG_NAME,
      adminEmail: SEED_ADMIN_EMAIL,
      webhookSecretHash,
      createdAt: now,
      updatedAt: now
    });
  }

  const existingUser = (await queryDocuments<Record<string, unknown>>("users", { email: SEED_ADMIN_EMAIL }, 1))[0];
  if (existingUser?._key) {
    await updateDocument("users", String(existingUser._key), {
      orgId: SEED_ORG_ID,
      orgName: SEED_ORG_NAME,
      passwordHash: await bcrypt.hash(SEED_ADMIN_PASSWORD, 12),
      updatedAt: now
    });
  } else {
    await insertDocument("users", {
      _key: createKvKey(),
      orgId: SEED_ORG_ID,
      orgName: SEED_ORG_NAME,
      email: SEED_ADMIN_EMAIL,
      passwordHash: await bcrypt.hash(SEED_ADMIN_PASSWORD, 12),
      role: "admin",
      createdAt: now,
      updatedAt: now
    });
  }
  return { orgId: SEED_ORG_ID, orgName: SEED_ORG_NAME, adminEmail: SEED_ADMIN_EMAIL, webhookSecret: SEED_WEBHOOK_SECRET };
}

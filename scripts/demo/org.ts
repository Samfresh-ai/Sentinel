import bcrypt from "bcryptjs";
import { createCollection, createKvKey, getDocument, insertDocument, queryDocuments, updateDocument } from "@operaiq/splunk-brain";

export const DEMO_ORG_ID = process.env.DEMO_ORG_ID ?? "demo-org";
export const DEMO_ORG_NAME = process.env.DEMO_ORG_NAME ?? "Sentinel Demo";
export const DEMO_ADMIN_EMAIL = (process.env.DEMO_ADMIN_EMAIL ?? "demo@sentinel.local").toLowerCase();
export const DEMO_ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? "sentinel-demo-password";
export const DEMO_WEBHOOK_SECRET = process.env.DEMO_WEBHOOK_SECRET ?? "sentinel-demo-webhook-secret";

export async function ensureDemoOrg(): Promise<{ orgId: string; orgName: string; adminEmail: string; webhookSecret: string }> {
  await createCollection("orgs", {});
  await createCollection("users", {});
  const now = new Date().toISOString();
  const webhookSecretHash = await bcrypt.hash(DEMO_WEBHOOK_SECRET, 12);
  const existingOrg = await getDocument<Record<string, unknown>>("orgs", DEMO_ORG_ID).catch(() => null);
  if (existingOrg) {
    await updateDocument("orgs", DEMO_ORG_ID, {
      orgName: DEMO_ORG_NAME,
      adminEmail: DEMO_ADMIN_EMAIL,
      webhookSecretHash,
      updatedAt: now
    });
  } else {
    await insertDocument("orgs", {
      _key: DEMO_ORG_ID,
      orgName: DEMO_ORG_NAME,
      adminEmail: DEMO_ADMIN_EMAIL,
      webhookSecretHash,
      createdAt: now,
      updatedAt: now
    });
  }

  const existingUser = (await queryDocuments<Record<string, unknown>>("users", { email: DEMO_ADMIN_EMAIL }, 1))[0];
  if (existingUser?._key) {
    await updateDocument("users", String(existingUser._key), {
      orgId: DEMO_ORG_ID,
      orgName: DEMO_ORG_NAME,
      passwordHash: await bcrypt.hash(DEMO_ADMIN_PASSWORD, 12),
      updatedAt: now
    });
  } else {
    await insertDocument("users", {
      _key: createKvKey(),
      orgId: DEMO_ORG_ID,
      orgName: DEMO_ORG_NAME,
      email: DEMO_ADMIN_EMAIL,
      passwordHash: await bcrypt.hash(DEMO_ADMIN_PASSWORD, 12),
      role: "admin",
      createdAt: now,
      updatedAt: now
    });
  }
  return { orgId: DEMO_ORG_ID, orgName: DEMO_ORG_NAME, adminEmail: DEMO_ADMIN_EMAIL, webhookSecret: DEMO_WEBHOOK_SECRET };
}

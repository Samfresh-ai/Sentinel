import "dotenv/config";
import { PubSub } from "@google-cloud/pubsub";
import { DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD, ensureDemoOrg } from "./demo/org.js";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function booleanEnv(name: string): boolean {
  return process.env[name]?.toLowerCase() === "true";
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${body}`);
  }
  return JSON.parse(body) as T;
}

async function requestOk(url: string, init?: RequestInit): Promise<void> {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${body}`);
  }
}

async function demoToken(apiUrl: string): Promise<string> {
  await ensureDemoOrg();
  const response = await requestJson<{ token: string }>(`${apiUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DEMO_ADMIN_EMAIL, password: DEMO_ADMIN_PASSWORD })
  });
  return response.token;
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function startAgentEventCollection(): Promise<{
  events: Array<{ incidentId: string; stepType: string; message: string }>;
  stop: () => Promise<void>;
}> {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  if (!projectId) throw new Error("GOOGLE_CLOUD_PROJECT_ID is required for Pub/Sub verification");
  const topicName = process.env.PUBSUB_EVENTS_TOPIC ?? "operaiq-agent-events";
  const subscriptionName = `operaiq-verify-${Date.now()}`;
  const pubsub = new PubSub({ projectId });
  const topic = pubsub.topic(topicName);
  const [subscription] = await topic.createSubscription(subscriptionName, { expirationPolicy: { ttl: { seconds: 86_400 } } });
  const events: Array<{ incidentId: string; stepType: string; message: string }> = [];
  subscription.on("message", (message) => {
    try {
      const parsed = JSON.parse(message.data.toString("utf8")) as { incidentId?: string; stepType?: string; message?: string };
      if (parsed.incidentId && parsed.stepType && parsed.message) {
        events.push({ incidentId: parsed.incidentId, stepType: parsed.stepType, message: parsed.message });
      }
      message.ack();
    } catch {
      message.nack();
    }
  });
  return {
    events,
    stop: async () => {
      await subscription.close();
      await subscription.delete().catch(() => undefined);
    }
  };
}

async function main(): Promise<void> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const token = await demoToken(apiUrl);
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("WEBHOOK_SECRET is required");

  const collector = await startAgentEventCollection();
  try {
    const alert = {
      source: "operaiq",
      title: "S3 bucket permission regression blocked notifications",
      severity: "P3",
      service: "notification-service",
      symptoms: ["S3 AccessDenied", "template asset reads failing", "notification send errors"],
      incidentType: "s3-bucket-permission-error"
    };
    const webhook = await requestJson<{ incidentId: string; pubsubMessageId: string }>(`${apiUrl}/webhooks/alert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-operaiq-secret": secret
      },
      body: JSON.stringify(alert)
    });

    if (booleanEnv("OPERAIQ_LOCAL_PUBSUB_DIRECT")) {
      await requestOk(`${apiUrl}/pubsub/alerts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            data: Buffer.from(JSON.stringify({ incidentId: webhook.incidentId, alert })).toString("base64")
          }
        })
      });
    }

    let finalIncident: { incident: { status: string; postMortemId: string | null; embeddingDimensions: number; updatedAt: string; createdAt?: string }; postmortem: unknown } | null = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const detail = await requestJson<{
        incident: { status: string; postMortemId: string | null; embeddingDimensions: number; updatedAt: string; createdAt?: string };
        postmortem: unknown;
      }>(`${apiUrl}/incidents/${webhook.incidentId}?legacy=operaiq`, { headers: { Authorization: `Bearer ${token}` } });
      if (detail.incident.status === "resolved") {
        finalIncident = detail;
        break;
      }
      await delay(5_000);
    }

    const events = collector.events.filter((event) => event.incidentId === webhook.incidentId);
    if (!finalIncident) {
      throw new Error("Incident did not transition to resolved within 120 seconds");
    }
    if (!finalIncident.incident.postMortemId || !finalIncident.postmortem) {
      throw new Error("Resolved incident does not have a post-mortem");
    }
    if (finalIncident.incident.embeddingDimensions !== 768) {
      throw new Error(`Expected 768-dim incident embedding, found ${finalIncident.incident.embeddingDimensions}`);
    }
    const toolLikeSteps = new Set(events.map((event) => event.stepType).filter((step) => ["REMEMBER", "MAP", "RETRIEVE", "ACT", "CLOSE"].includes(step)));
    if (toolLikeSteps.size < 3) {
      throw new Error(`Expected at least 3 agent tool phases from Pub/Sub events, found ${[...toolLikeSteps].join(", ")}`);
    }
  } finally {
    await collector.stop();
  }

  writeLine("PASSED verify:e2e - End-to-end flow: PASSED");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED verify:e2e - ${message}`);
  process.exitCode = 1;
});

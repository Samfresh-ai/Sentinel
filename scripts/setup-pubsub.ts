import "dotenv/config";
import { PubSub, type Topic } from "@google-cloud/pubsub";
import type { CreateSubscriptionOptions } from "@google-cloud/pubsub/build/src/subscription.js";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function ensureTopic(pubsub: PubSub, name: string): Promise<Topic> {
  const topic = pubsub.topic(name);
  const [exists] = await topic.exists();
  if (exists) {
    writeLine(`Topic exists: ${name}`);
    return topic;
  }
  const [created] = await pubsub.createTopic(name);
  writeLine(`Created topic: ${name}`);
  return created;
}

async function ensureSubscription(topic: Topic, name: string, options?: CreateSubscriptionOptions): Promise<void> {
  const subscription = topic.subscription(name);
  const [exists] = await subscription.exists();
  if (exists) {
    writeLine(`Subscription exists: ${name}`);
    return;
  }
  await topic.createSubscription(name, options);
  writeLine(`Created subscription: ${name}`);
}

function pushOptions(pushEndpoint: string): CreateSubscriptionOptions {
  const serviceAccountEmail = process.env.PUBSUB_PUSH_SERVICE_ACCOUNT;
  const audience = process.env.PUBSUB_PUSH_AUDIENCE ?? pushEndpoint;
  if (!serviceAccountEmail) {
    return { pushEndpoint };
  }
  return {
    pushEndpoint,
    oidcToken: {
      serviceAccountEmail,
      audience
    }
  };
}

function resolvePushEndpoint(apiUrl: string): string {
  const configuredEndpoint = process.env.PUBSUB_PUSH_ENDPOINT?.trim();
  const pushEndpoint = configuredEndpoint && configuredEndpoint.length > 0 ? configuredEndpoint : `${apiUrl}/pubsub/alerts`;
  const parsed = new URL(pushEndpoint);
  if (parsed.protocol !== "https:") {
    throw new Error(
      `Pub/Sub push subscriptions require a public HTTPS endpoint. Set PUBSUB_PUSH_ENDPOINT to the deployed API endpoint ending in /pubsub/alerts; received ${parsed.origin}.`
    );
  }
  return pushEndpoint;
}

async function main(): Promise<void> {
  const projectId = requiredEnv("GOOGLE_CLOUD_PROJECT_ID");
  const apiUrl = requiredEnv("NEXT_PUBLIC_API_URL").replace(/\/$/, "");
  const alertTopicName = process.env.PUBSUB_ALERT_TOPIC ?? "operaiq-alerts";
  const eventsTopicName = process.env.PUBSUB_EVENTS_TOPIC ?? "operaiq-agent-events";
  const alertSubscriptionName = process.env.PUBSUB_ALERT_PUSH_SUBSCRIPTION ?? "operaiq-alerts-agent-push";
  const eventsSubscriptionName = process.env.PUBSUB_EVENTS_SUBSCRIPTION ?? "operaiq-agent-events-sse";
  const pushEndpoint = resolvePushEndpoint(apiUrl);

  const pubsub = new PubSub({ projectId });
  const alertTopic = await ensureTopic(pubsub, alertTopicName);
  const eventsTopic = await ensureTopic(pubsub, eventsTopicName);
  await ensureSubscription(alertTopic, alertSubscriptionName, pushOptions(pushEndpoint));
  await ensureSubscription(eventsTopic, eventsSubscriptionName);
  writeLine("PASSED setup:pubsub - topics and subscriptions are present");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED setup:pubsub - ${message}`);
  process.exitCode = 1;
});

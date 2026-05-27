import { PubSub, type Message } from "@google-cloud/pubsub";
import { agentEventSchema, type AgentEvent } from "@operaiq/shared";

let pubsub: PubSub | undefined;

function client(): PubSub {
  if (!pubsub) {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
    pubsub = projectId ? new PubSub({ projectId }) : new PubSub();
  }
  return pubsub;
}

export async function publishAlertEvent(payload: { incidentId: string; alert: unknown }): Promise<string> {
  const topicName = process.env.PUBSUB_ALERT_TOPIC ?? "operaiq-alerts";
  const messageId = await client().topic(topicName).publishMessage({
    json: payload
  });
  return messageId;
}

export async function publishAgentEvent(event: AgentEvent): Promise<string> {
  const topicName = process.env.PUBSUB_EVENTS_TOPIC ?? "operaiq-agent-events";
  return client().topic(topicName).publishMessage({ json: event });
}

export function decodePubSubJsonMessage(message: unknown): unknown {
  if (typeof message !== "object" || message === null || !("message" in message)) {
    throw new Error("Invalid Pub/Sub push envelope");
  }
  const envelope = message as { message?: { data?: unknown } };
  if (typeof envelope.message?.data !== "string") {
    throw new Error("Pub/Sub push envelope is missing base64 data");
  }
  const raw = Buffer.from(envelope.message.data, "base64").toString("utf8");
  return JSON.parse(raw);
}

type EventHandler = (event: AgentEvent) => void;

let eventsSubscriptionStarted = false;
const eventHandlers = new Set<EventHandler>();

export function addAgentEventHandler(handler: EventHandler): () => void {
  eventHandlers.add(handler);
  return () => {
    eventHandlers.delete(handler);
  };
}

export function dispatchAgentEvent(event: AgentEvent): void {
  for (const handler of eventHandlers) {
    handler(event);
  }
}

export async function startAgentEventsSubscription(): Promise<void> {
  if (eventsSubscriptionStarted) return;
  eventsSubscriptionStarted = true;
  const topicName = process.env.PUBSUB_EVENTS_TOPIC ?? "operaiq-agent-events";
  const subscriptionName = process.env.PUBSUB_EVENTS_SUBSCRIPTION ?? "operaiq-agent-events-sse";
  const topic = client().topic(topicName);
  const [exists] = await topic.subscription(subscriptionName).exists();
  if (!exists) {
    await topic.createSubscription(subscriptionName);
  }
  const subscription = topic.subscription(subscriptionName);
  subscription.on("message", (message: Message) => {
    try {
      const parsed = agentEventSchema.parse(JSON.parse(message.data.toString("utf8")));
      dispatchAgentEvent(parsed);
      message.ack();
    } catch {
      message.nack();
    }
  });
}

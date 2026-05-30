import type { AgentEvent } from "@sentinel/shared";

type EventHandler = (event: AgentEvent) => void;

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

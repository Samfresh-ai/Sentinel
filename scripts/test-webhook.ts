import "dotenv/config";

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${body}`);
  }
  return JSON.parse(body) as T;
}

async function main(): Promise<void> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("WEBHOOK_SECRET is required");

  const payload = {
    source: "operaiq",
    title: "Payment service database connection timeout",
    severity: "P2",
    service: "payment-service",
    symptoms: ["database connection timeout", "postgres pool exhausted", "checkout latency"],
    incidentType: "postgres-connection-pool-failure"
  };

  const response = await requestJson<{ incidentId: string; pubsubMessageId: string }>(`${apiUrl}/webhooks/alert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-operaiq-secret": secret
    },
    body: JSON.stringify(payload)
  });
  if (!response.incidentId || !response.pubsubMessageId) {
    throw new Error("Webhook response did not include incidentId and Pub/Sub message ID");
  }
  const incident = await requestJson<{ incident: { id: string; status: string } }>(`${apiUrl}/incidents/${response.incidentId}`);
  if (incident.incident.id !== response.incidentId || incident.incident.status !== "open") {
    throw new Error("Created incident was not retrievable with open status");
  }
  writeLine(`PASSED test-webhook - incident=${response.incidentId}, pubsubMessageId=${response.pubsubMessageId}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED test-webhook - ${message}`);
  process.exitCode = 1;
});

import "dotenv/config";
import https from "node:https";
import { Buffer } from "node:buffer";
import { getSplunkConfig, splunkRestRequest } from "@operaiq/splunk-brain";
import { z } from "zod";

const SplunkEntriesSchema = z.object({
  entry: z
    .array(
      z.object({
        name: z.string(),
        content: z.record(z.unknown()).optional().default({})
      })
    )
    .default([])
});

function writeLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function field(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function entryText(entry: { name: string; content: Record<string, unknown> }): string {
  return [entry.name, field(entry.content.label), field(entry.content.title)].join(" ").toLowerCase();
}

async function splunkRawRequest(input: { method?: "GET" | "POST"; path: string; form?: Record<string, string> }): Promise<{ status: number; text: string }> {
  const config = getSplunkConfig();
  const body = input.form ? new URLSearchParams(input.form).toString() : undefined;
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        hostname: config.SPLUNK_HOST,
        port: config.SPLUNK_MGMT_PORT,
        method: input.method ?? "GET",
        path: input.path,
        rejectUnauthorized: false,
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.SPLUNK_USERNAME}:${config.SPLUNK_PASSWORD}`).toString("base64")}`,
          ...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body).toString() } : {})
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function splunkMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { messages?: Array<{ text?: string }> };
    return parsed.messages?.map((message) => message.text).filter(Boolean).join("; ") || text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

async function listApps(): Promise<Array<{ name: string; content: Record<string, unknown> }>> {
  const response = await splunkRestRequest(SplunkEntriesSchema, {
    path: "/services/apps/local",
    query: { output_mode: "json", count: 0 }
  });
  return (response.entry ?? []).map((entry) => ({ name: entry.name, content: entry.content ?? {} }));
}

async function listSearchCommands(): Promise<Set<string>> {
  const response = await splunkRestRequest(SplunkEntriesSchema, {
    path: "/servicesNS/nobody/search/data/commands",
    query: { output_mode: "json", count: 0 }
  });
  return new Set((response.entry ?? []).map((entry) => entry.name));
}

async function checkScsTokenEndpoint(): Promise<string | null> {
  const response = await splunkRawRequest({
    path: "/services/authorization/scs_tokens?principalId=slim&scope=tenant&output_mode=json"
  });
  if (response.status >= 200 && response.status < 300) {
    writeLine("PASSED splunk-scs-token-endpoint - SCS token endpoint returned 2xx");
    return null;
  }
  const message = `status=${response.status} message=${splunkMessage(response.text)}`;
  writeLine(`FAILED splunk-scs-token-endpoint - ${message}`);
  return message;
}

async function waitForJob(sid: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const status = await splunkRawRequest({
      path: `/services/search/jobs/${encodeURIComponent(sid)}?output_mode=json`
    });
    if (status.status < 200 || status.status >= 300) throw new Error(`job status failed: ${splunkMessage(status.text)}`);
    const parsed = JSON.parse(status.text) as { entry?: Array<{ content?: { dispatchState?: string; isDone?: boolean | number | string } }> };
    const content = parsed.entry?.[0]?.content;
    if (content?.dispatchState === "DONE" || content?.isDone === true || content?.isDone === 1 || content?.isDone === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("search job did not finish within 120 seconds");
}

async function runHostedModelSearch(spl: string): Promise<Array<Record<string, unknown>>> {
  const created = await splunkRawRequest({
    method: "POST",
    path: "/services/search/jobs",
    form: { output_mode: "json", search: spl }
  });
  if (created.status < 200 || created.status >= 300) throw new Error(`search create failed: ${splunkMessage(created.text)}`);
  const sid = (JSON.parse(created.text) as { sid?: string }).sid;
  if (!sid) throw new Error("search create did not return a sid");
  await waitForJob(sid);
  const results = await splunkRawRequest({
    path: `/services/search/jobs/${encodeURIComponent(sid)}/results?output_mode=json&count=3`
  });
  if (results.status < 200 || results.status >= 300) throw new Error(splunkMessage(results.text));
  const parsed = JSON.parse(results.text) as { results?: Array<Record<string, unknown>> };
  return parsed.results ?? [];
}

async function runHostedModelProbe(): Promise<string | null> {
  const queries = [
    '| makeresults | eval sentinel_probe="Reply with SENTINEL_OK only." | ai prompt="{sentinel_probe}" provider="Splunk Hosted Models" model="OpenAI GPT-OSS 20B"',
    '| makeresults | eval sentinel_probe="Reply with SENTINEL_OK only." | ai prompt="{sentinel_probe}" provider="Splunk Hosted Models" model="gpt-oss-20b"',
    '| makeresults | eval sentinel_probe="Reply with SENTINEL_OK only." | ai prompt="{sentinel_probe}"'
  ];

  const errors: string[] = [];
  for (const spl of queries) {
    try {
      const results = await runHostedModelSearch(spl);
      if (results.length === 0) throw new Error("search completed with zero result rows");
      writeLine(`PASSED splunk-hosted-models-search - spl=${JSON.stringify(spl)} resultCount=${results.length}`);
      writeLine(`CHECK splunk-hosted-models-sample - ${JSON.stringify(results[0] ?? {})}`);
      return null;
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const message = errors.join(" | ");
  writeLine(`FAILED splunk-hosted-models-search - ${message}`);
  return message;
}

async function main(): Promise<void> {
  await splunkRestRequest(z.record(z.unknown()), {
    path: "/services/server/info",
    query: { output_mode: "json" }
  });
  writeLine("PASSED splunk-rest - management API is reachable");

  const apps = await listApps();
  const appTexts = apps.map(entryText);
  const hasAiToolkit = appTexts.some((text) => text.includes("splunk_ml_toolkit") || text.includes("ai toolkit") || text.includes("machine learning toolkit"));
  const hasPsc = appTexts.some((text) => text.includes("scientific python") || text.includes("scientific computing") || text.includes("splunk_sa_scientific"));

  writeLine(`${hasAiToolkit ? "PASSED" : "FAILED"} splunk-ai-toolkit-app - ${hasAiToolkit ? "AI Toolkit app is installed" : "AI Toolkit app is not installed"}`);
  writeLine(`${hasPsc ? "PASSED" : "FAILED"} splunk-psc-add-on - ${hasPsc ? "Python for Scientific Computing add-on is installed" : "Python for Scientific Computing add-on is not installed"}`);

  const commands = await listSearchCommands();
  const hasAiCommand = commands.has("ai");
  const legacyCommands = ["genai", "llmgenerate"].filter((name) => commands.has(name));
  writeLine(`${hasAiCommand ? "PASSED" : "FAILED"} splunk-ai-command - ${hasAiCommand ? "`ai` search command is available" : "`ai` search command is unavailable"}`);
  writeLine(`CHECK splunk-legacy-llm-commands - found=${legacyCommands.length > 0 ? legacyCommands.join(",") : "none"}`);

  if (!hasAiToolkit || !hasPsc || !hasAiCommand) {
    throw new Error("Splunk Hosted Models are blocked until AI Toolkit 5.7.x, the matching Python for Scientific Computing add-on, and the `ai` SPL command are installed in Splunk.");
  }

  const failures = [await checkScsTokenEndpoint(), await runHostedModelProbe()].filter((failure): failure is string => Boolean(failure));
  if (failures.length > 0) {
    throw new Error(`Splunk Hosted Models are installed but not callable yet: ${failures.join(" | ")}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED splunk:hosted-models-check - ${message}`);
  process.exitCode = 1;
});

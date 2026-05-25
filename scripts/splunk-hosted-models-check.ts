import "dotenv/config";
import { runSearch, splunkRestRequest } from "@operaiq/splunk-brain";
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

async function listApps(): Promise<Array<{ name: string; content: Record<string, unknown> }>> {
  const response = await splunkRestRequest(SplunkEntriesSchema, {
    path: "/services/apps/local",
    query: { output_mode: "json", count: 0 }
  });
  return (response.entry ?? []).map((entry) => ({ name: entry.name, content: entry.content ?? {} }));
}

async function listSearchCommands(): Promise<Set<string>> {
  const response = await splunkRestRequest(SplunkEntriesSchema, {
    path: "/servicesNS/nobody/search/admin/commands",
    query: { output_mode: "json", count: 0 }
  });
  return new Set((response.entry ?? []).map((entry) => entry.name));
}

async function runHostedModelProbe(): Promise<void> {
  const queries = [
    '| makeresults | eval sentinel_probe="Reply with SENTINEL_OK only." | ai prompt="{sentinel_probe}" provider="Splunk Hosted Models"',
    '| makeresults | eval sentinel_probe="Reply with SENTINEL_OK only." | ai prompt="{sentinel_probe}"'
  ];

  const errors: string[] = [];
  for (const spl of queries) {
    try {
      const results = await runSearch(spl, { maxResults: 3 });
      writeLine(`PASSED splunk-hosted-models-search - spl=${JSON.stringify(spl)} resultCount=${results.length}`);
      writeLine(`CHECK splunk-hosted-models-sample - ${JSON.stringify(results[0] ?? {})}`);
      return;
    } catch (error: unknown) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`AI Toolkit command exists, but hosted model probe failed: ${errors.join(" | ")}`);
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

  await runHostedModelProbe();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  writeLine(`FAILED splunk:hosted-models-check - ${message}`);
  process.exitCode = 1;
});

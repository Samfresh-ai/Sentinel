import http from "node:http";
import https from "node:https";
import { Buffer } from "node:buffer";
import { createLogger } from "@operaiq/shared";
import { z } from "zod";
import { getSplunkEnv, type SplunkEnv } from "./env.js";

const logger = createLogger("sentinel-splunk-client");
let warnedSelfSigned = false;

export type SplunkConfig = SplunkEnv;

export const SplunkConfigSchema = z.object({
  SPLUNK_HOST: z.string().default("localhost"),
  SPLUNK_MGMT_PORT: z.number().default(8089),
  SPLUNK_HEC_PORT: z.number().default(8088),
  SPLUNK_USERNAME: z.string(),
  SPLUNK_PASSWORD: z.string(),
  SPLUNK_HEC_TOKEN: z.string(),
  SPLUNK_APP: z.string().default("sentinel"),
  SPLUNK_INDEX: z.string().default("sentinel")
});

export function getSplunkConfig(): SplunkConfig {
  return getSplunkEnv();
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function shouldAllowSelfSigned(config: SplunkConfig): boolean {
  return isLocalHost(config.SPLUNK_HOST);
}

function pathWithParams(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }
  const queryString = params.toString();
  return queryString.length > 0 ? `${path}?${queryString}` : path;
}

function formBody(form: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

async function readResponseBody(response: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function requestRaw(input: {
  protocol: "http:" | "https:";
  host: string;
  port: number;
  method: "GET" | "POST" | "DELETE";
  path: string;
  headers?: Record<string, string>;
  body?: string;
  rejectUnauthorized?: boolean;
}): Promise<string> {
  const transport = input.protocol === "https:" ? https : http;
  const body = input.body;
  const headers = {
    ...(input.headers ?? {}),
    ...(body ? { "Content-Length": Buffer.byteLength(body).toString() } : {})
  };
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: input.protocol,
        hostname: input.host,
        port: input.port,
        method: input.method,
        path: input.path,
        headers,
        rejectUnauthorized: input.protocol === "https:" ? input.rejectUnauthorized : undefined
      },
      async (response) => {
        const text = await readResponseBody(response);
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          reject(new Error(`Splunk ${input.method} ${input.path} failed with ${statusCode}: ${text}`));
          return;
        }
        resolve(text);
      }
    );
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

function parseJson(text: string): unknown {
  if (text.trim().length === 0) return {};
  return JSON.parse(text) as unknown;
}

export async function splunkRestRequest<T>(
  schema: z.ZodType<T>,
  input: {
    method?: "GET" | "POST" | "DELETE";
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    form?: Record<string, string | number | boolean | undefined>;
    json?: unknown;
  }
): Promise<T> {
  const config = getSplunkConfig();
  const allowSelfSigned = shouldAllowSelfSigned(config);
  if (allowSelfSigned && !warnedSelfSigned) {
    logger.warn({ host: config.SPLUNK_HOST }, "Splunk local self-signed certificate validation is disabled for localhost only");
    warnedSelfSigned = true;
  }
  const body = input.json !== undefined ? JSON.stringify(input.json) : input.form ? formBody(input.form) : undefined;
  const requestInput = {
    protocol: "https:",
    host: config.SPLUNK_HOST,
    port: config.SPLUNK_MGMT_PORT,
    method: input.method ?? "GET",
    path: pathWithParams(input.path, input.query),
    rejectUnauthorized: !allowSelfSigned,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.SPLUNK_USERNAME}:${config.SPLUNK_PASSWORD}`).toString("base64")}`,
      ...(input.json !== undefined
        ? { "Content-Type": "application/json" }
        : input.form
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {})
    }
  } satisfies Parameters<typeof requestRaw>[0];
  const text = await requestRaw(body ? { ...requestInput, body } : requestInput);
  return schema.parse(parseJson(text));
}

export async function splunkHecRequest<T>(schema: z.ZodType<T>, payload: unknown): Promise<T> {
  const config = getSplunkConfig();
  const text = await requestRaw({
    protocol: "http:",
    host: config.SPLUNK_HOST,
    port: config.SPLUNK_HEC_PORT,
    method: "POST",
    path: "/services/collector/event",
    body: JSON.stringify(payload),
    headers: {
      Authorization: `Splunk ${config.SPLUNK_HEC_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
  return schema.parse(parseJson(text));
}

export const emptyResponseSchema = z.record(z.unknown()).default({});

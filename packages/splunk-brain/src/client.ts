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
  SPLUNK_CLOUD_STACK_HOST: z.string().optional(),
  SPLUNK_MGMT_URL: z.string().url().optional(),
  SPLUNK_HEC_URL: z.string().url().optional(),
  SPLUNK_MGMT_PORT: z.number().default(8089),
  SPLUNK_HEC_PORT: z.number().default(8088),
  SPLUNK_HEC_PROTOCOL: z.enum(["http", "https"]).default("https"),
  SPLUNK_USERNAME: z.string(),
  SPLUNK_PASSWORD: z.string(),
  SPLUNK_HEC_TOKEN: z.string(),
  SPLUNK_GATEWAY_TOKEN: z.string().optional(),
  SPLUNK_CF_ACCESS_CLIENT_ID: z.string().optional(),
  SPLUNK_CF_ACCESS_CLIENT_SECRET: z.string().optional(),
  SPLUNK_APP: z.string().default("sentinel"),
  SPLUNK_INDEX: z.string().default("sentinel")
});

export function getSplunkConfig(): SplunkConfig {
  return getSplunkEnv();
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function endpointFromUrl(value: string): {
  protocol: "http:" | "https:";
  host: string;
  port?: number;
  basePath: string;
} {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Splunk endpoint must use http or https: ${url.protocol}`);
  }
  return {
    protocol: url.protocol,
    host: url.hostname,
    ...(url.port ? { port: Number.parseInt(url.port, 10) } : {}),
    basePath: url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")
  };
}

function cloudStackHost(config: SplunkConfig): string | undefined {
  const raw = config.SPLUNK_CLOUD_STACK_HOST?.trim();
  if (!raw) return undefined;
  const withoutProtocol = raw.replace(/^https?:\/\//i, "");
  const host = withoutProtocol.split("/")[0]?.replace(/:\d+$/, "").toLowerCase();
  if (!host) return undefined;
  return host.includes(".") ? host : `${host}.splunkcloud.com`;
}

function cloudHecHost(stackHost: string): string {
  if (stackHost.startsWith("http-inputs-") || stackHost.startsWith("http-inputs.")) return stackHost;
  if (stackHost.endsWith(".splunkcloud.com")) return `http-inputs-${stackHost}`;
  return `http-inputs-${stackHost}`;
}

function shouldAllowSelfSigned(endpoint: { host: string }): boolean {
  return isLocalHost(endpoint.host);
}

function managementEndpoint(config: SplunkConfig): {
  protocol: "http:" | "https:";
  host: string;
  port?: number;
  basePath: string;
} {
  if (config.SPLUNK_MGMT_URL) return endpointFromUrl(config.SPLUNK_MGMT_URL);
  const stackHost = cloudStackHost(config);
  if (stackHost) {
    return {
      protocol: "https:",
      host: stackHost,
      port: config.SPLUNK_MGMT_PORT,
      basePath: ""
    };
  }
  return {
    protocol: "https:",
    host: config.SPLUNK_HOST,
    port: config.SPLUNK_MGMT_PORT,
    basePath: ""
  };
}

function hecEndpoint(config: SplunkConfig): {
  protocol: "http:" | "https:";
  host: string;
  port?: number;
  basePath: string;
} {
  if (config.SPLUNK_HEC_URL) return endpointFromUrl(config.SPLUNK_HEC_URL);
  const stackHost = cloudStackHost(config);
  if (stackHost) {
    return {
      protocol: "https:",
      host: cloudHecHost(stackHost),
      port: config.SPLUNK_HEC_PORT,
      basePath: ""
    };
  }
  return {
    protocol: `${config.SPLUNK_HEC_PROTOCOL}:`,
    host: config.SPLUNK_HOST,
    port: config.SPLUNK_HEC_PORT,
    basePath: ""
  };
}

function accessHeaders(config: SplunkConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (cloudStackHost(config)) return headers;
  if (config.SPLUNK_GATEWAY_TOKEN) {
    headers["x-sentinel-splunk-gateway-token"] = config.SPLUNK_GATEWAY_TOKEN;
  }
  if (config.SPLUNK_CF_ACCESS_CLIENT_ID && config.SPLUNK_CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = config.SPLUNK_CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = config.SPLUNK_CF_ACCESS_CLIENT_SECRET;
  }
  return headers;
}

function requestEndpoint(endpoint: {
  protocol: "http:" | "https:";
  host: string;
  port?: number;
}): {
  protocol: "http:" | "https:";
  host: string;
  port?: number;
} {
  return endpoint.port === undefined
    ? { protocol: endpoint.protocol, host: endpoint.host }
    : { protocol: endpoint.protocol, host: endpoint.host, port: endpoint.port };
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
  port?: number;
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
        ...(input.port !== undefined ? { port: input.port } : {}),
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
  const endpoint = managementEndpoint(config);
  const allowSelfSigned = shouldAllowSelfSigned(endpoint);
  if (allowSelfSigned && !warnedSelfSigned) {
    logger.warn({ host: endpoint.host }, "Splunk local self-signed certificate validation is disabled for localhost only");
    warnedSelfSigned = true;
  }
  const body = input.json !== undefined ? JSON.stringify(input.json) : input.form ? formBody(input.form) : undefined;
  const requestInput = {
    ...requestEndpoint(endpoint),
    method: input.method ?? "GET",
    path: `${endpoint.basePath}${pathWithParams(input.path, input.query)}`,
    rejectUnauthorized: !allowSelfSigned,
    headers: {
      ...accessHeaders(config),
      // SCS tokens are Splunk Cloud Platform only. Local Enterprise uses Basic Auth.
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
  const endpoint = hecEndpoint(config);
  const text = await requestRaw({
    ...requestEndpoint(endpoint),
    method: "POST",
    path: `${endpoint.basePath}/services/collector/event`,
    body: JSON.stringify(payload),
    rejectUnauthorized: !shouldAllowSelfSigned(endpoint),
    headers: {
      ...accessHeaders(config),
      Authorization: `Splunk ${config.SPLUNK_HEC_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
  return schema.parse(parseJson(text));
}

export const emptyResponseSchema = z.record(z.unknown()).default({});

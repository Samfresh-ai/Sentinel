import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { Buffer } from "node:buffer";
import { createLogger } from "@sentinel/shared";
import { z } from "zod";
import { getSplunkEnv, type SplunkEnv } from "./env.js";

const logger = createLogger("sentinel-splunk-client");
let warnedSelfSigned = false;
let warnedTlsDisabled = false;

export type SplunkConfig = SplunkEnv;

const booleanEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["false", "0", "no"].includes(normalized)) return false;
  if (["true", "1", "yes"].includes(normalized)) return true;
  return value;
}, z.boolean());

export const SplunkConfigSchema = z.object({
  SPLUNK_HOST: z.string().default("localhost"),
  SPLUNK_CLOUD_STACK_HOST: z.string().optional(),
  SPLUNK_MGMT_URL: z.string().url().optional(),
  SPLUNK_HEC_URL: z.string().url().optional(),
  SPLUNK_MGMT_PORT: z.number().default(8089),
  SPLUNK_HEC_PORT: z.number().default(8088),
  SPLUNK_HEC_PROTOCOL: z.enum(["http", "https"]).default("https"),
  SPLUNK_TLS_REJECT_UNAUTHORIZED: booleanEnv.default(true),
  SPLUNK_CA_CERT: z.string().optional(),
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

function shouldAllowSelfSigned(endpoint: { host: string }): boolean {
  return isLocalHost(endpoint.host);
}

function shouldRejectUnauthorized(config: SplunkConfig, endpoint: { host: string }): boolean {
  if (shouldAllowSelfSigned(endpoint)) return false;
  return config.SPLUNK_TLS_REJECT_UNAUTHORIZED;
}

function assertSecureEndpoint(config: SplunkConfig, endpoint: { protocol: "http:" | "https:"; host: string }, purpose: string): void {
  if (isLocalHost(endpoint.host)) return;
  if (endpoint.protocol !== "https:") {
    throw new Error(`${purpose} must use HTTPS for non-local Splunk endpoint ${endpoint.host}`);
  }
  if (!config.SPLUNK_TLS_REJECT_UNAUTHORIZED) {
    throw new Error(`${purpose} cannot disable TLS certificate validation for non-local Splunk endpoint ${endpoint.host}`);
  }
}

function warnTlsChoice(config: SplunkConfig, endpoint: { host: string }): void {
  if (shouldAllowSelfSigned(endpoint) && !warnedSelfSigned) {
    logger.warn({ host: endpoint.host }, "Splunk local self-signed certificate validation is disabled for localhost only");
    warnedSelfSigned = true;
    return;
  }
  if (!config.SPLUNK_TLS_REJECT_UNAUTHORIZED && !warnedTlsDisabled) {
    logger.warn({ host: endpoint.host }, "Splunk TLS certificate validation is disabled by SPLUNK_TLS_REJECT_UNAUTHORIZED=false");
    warnedTlsDisabled = true;
  }
}

function customCertificateAuthorities(config: SplunkConfig): string[] | undefined {
  const pem = config.SPLUNK_CA_CERT?.trim().replace(/\\n/g, "\n");
  if (!pem) return undefined;
  return [...tls.rootCertificates, pem];
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
      basePath: "/en-US/splunkd"
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
      host: stackHost,
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

function hecCollectorEventPath(endpoint: { basePath: string }): string {
  const basePath = endpoint.basePath.replace(/\/+$/, "");
  if (basePath.endsWith("/services/collector/event")) return basePath;
  if (basePath.endsWith("/services/collector")) return `${basePath}/event`;
  return `${basePath}/services/collector/event`;
}

function endpointUrl(endpoint: {
  protocol: "http:" | "https:";
  host: string;
  port?: number;
  basePath: string;
}, path = endpoint.basePath): string {
  const port = endpoint.port === undefined ? "" : `:${endpoint.port}`;
  return `${endpoint.protocol}//${endpoint.host}${port}${path}`;
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
  ca?: string[];
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
        rejectUnauthorized: input.protocol === "https:" ? input.rejectUnauthorized : undefined,
        ...(input.protocol === "https:" && input.ca ? { ca: input.ca } : {})
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
  assertSecureEndpoint(config, endpoint, "Splunk management endpoint");
  const rejectUnauthorized = shouldRejectUnauthorized(config, endpoint);
  const ca = customCertificateAuthorities(config);
  warnTlsChoice(config, endpoint);
  const body = input.json !== undefined ? JSON.stringify(input.json) : input.form ? formBody(input.form) : undefined;
  const requestInput = {
    ...requestEndpoint(endpoint),
    method: input.method ?? "GET",
    path: `${endpoint.basePath}${pathWithParams(input.path, input.query)}`,
    rejectUnauthorized,
    ...(ca ? { ca } : {}),
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
  assertSecureEndpoint(config, endpoint, "Splunk HEC endpoint");
  const rejectUnauthorized = shouldRejectUnauthorized(config, endpoint);
  const ca = customCertificateAuthorities(config);
  warnTlsChoice(config, endpoint);
  const text = await requestRaw({
    ...requestEndpoint(endpoint),
    method: "POST",
    path: hecCollectorEventPath(endpoint),
    body: JSON.stringify(payload),
    rejectUnauthorized,
    ...(ca ? { ca } : {}),
    headers: {
      ...accessHeaders(config),
      Authorization: `Splunk ${config.SPLUNK_HEC_TOKEN}`,
      "Content-Type": "application/json"
    }
  });
  return schema.parse(parseJson(text));
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readyTimeoutMs(): number {
  const raw = Number.parseInt(process.env.SPLUNK_READY_TIMEOUT_MS ?? "300000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 300000;
}

function retryIntervalMs(): number {
  const raw = Number.parseInt(process.env.SPLUNK_READY_RETRY_MS ?? "5000", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

function isNonRetryableReadyError(message: string): boolean {
  return / failed with (401|403|404):/.test(message);
}

export async function waitForSplunkReady(input: {
  timeoutMs?: number;
  retryMs?: number;
  onRetry?: (attempt: number, message: string) => void;
} = {}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? readyTimeoutMs();
  const retryMs = input.retryMs ?? retryIntervalMs();
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastMessage = "Splunk management API did not respond";

  while (Date.now() <= deadline) {
    attempt += 1;
    try {
      await splunkRestRequest(z.record(z.unknown()), {
        path: "/services/server/info",
        query: { output_mode: "json" }
      });
      return;
    } catch (error: unknown) {
      lastMessage = error instanceof Error ? error.message : String(error);
      if (isNonRetryableReadyError(lastMessage)) {
        throw new Error(`Splunk management API is reachable but not usable: ${lastMessage}`);
      }
      if (Date.now() + retryMs > deadline) break;
      input.onRetry?.(attempt, lastMessage);
      await delay(retryMs);
    }
  }

  throw new Error(`Splunk management API was not ready after ${timeoutMs}ms: ${lastMessage}`);
}

export function describeSplunkEndpoints(): { managementUrl: string; hecUrl: string } {
  const config = getSplunkConfig();
  const management = managementEndpoint(config);
  const hec = hecEndpoint(config);
  return {
    managementUrl: endpointUrl(management),
    hecUrl: endpointUrl(hec, hecCollectorEventPath(hec))
  };
}

export const emptyResponseSchema = z.record(z.unknown()).default({});

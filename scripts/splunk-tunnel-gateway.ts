import crypto from "node:crypto";
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { loadRootEnv } from "@sentinel/shared";

loadRootEnv();

const port = Number.parseInt(process.env.SPLUNK_TUNNEL_GATEWAY_PORT ?? "19089", 10);
const gatewayToken = process.env.SPLUNK_GATEWAY_TOKEN?.trim();
const configuredMaxBodyBytes = Number.parseInt(process.env.SPLUNK_GATEWAY_MAX_BODY_BYTES ?? String(10 * 1024 * 1024), 10);
const maxBodyBytes = Number.isFinite(configuredMaxBodyBytes) && configuredMaxBodyBytes > 0 ? configuredMaxBodyBytes : 10 * 1024 * 1024;

function splunkTarget(path: string): { port: number; name: "hec" | "management" } {
  return path.startsWith("/services/collector") ? { port: 8088, name: "hec" } : { port: 8089, name: "management" };
}

function forwardHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const forwarded: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const normalized = key.toLowerCase();
    if (
      normalized === "host" ||
      normalized === "connection" ||
      normalized === "content-length" ||
      normalized === "x-sentinel-splunk-gateway-token" ||
      normalized.startsWith("cf-")
    ) {
      continue;
    }
    forwarded[key] = value;
  }
  return forwarded;
}

function payloadTooLargeError(): Error {
  const error = new Error("Splunk tunnel request body is too large");
  error.name = "PayloadTooLarge";
  return error;
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) throw payloadTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function authorized(req: http.IncomingMessage): boolean {
  if (!gatewayToken) return false;
  const supplied = req.headers["x-sentinel-splunk-gateway-token"];
  if (typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(gatewayToken);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && crypto.timingSafeEqual(expectedBuffer, suppliedBuffer);
}

const server = http.createServer(async (req, res) => {
  if (req.url === "/__sentinel_proxy_health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (!authorized(req)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized Splunk tunnel request" }));
    return;
  }

  try {
    const path = req.url ?? "/";
    const target = splunkTarget(path);
    const body = await readRequestBody(req);
    const headers = {
      ...forwardHeaders(req.headers),
      ...(body.length > 0 ? { "content-length": String(body.length) } : {})
    };

    const proxyReq = https.request(
      {
        hostname: "localhost",
        port: target.port,
        method: req.method,
        path,
        headers,
        rejectUnauthorized: false
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );

    proxyReq.on("error", (error) => {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `Splunk ${target.name} proxy failed`, message: error.message }));
    });

    if (body.length > 0) proxyReq.write(body);
    proxyReq.end();
  } catch (error) {
    const status = error instanceof Error && error.name === "PayloadTooLarge" ? 413 : 500;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: status === 413 ? "Splunk tunnel request body too large" : "Splunk tunnel request failed" }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Sentinel Splunk tunnel gateway listening on http://127.0.0.1:${port}`);
});

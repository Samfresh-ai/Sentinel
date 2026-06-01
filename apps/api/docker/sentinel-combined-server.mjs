import { spawn } from "node:child_process";
import http from "node:http";

const publicPort = Number.parseInt(process.env.PORT ?? "3001", 10);
const apiPort = Number.parseInt(process.env.SENTINEL_INTERNAL_API_PORT ?? "19001", 10);
const webPort = Number.parseInt(process.env.SENTINEL_INTERNAL_WEB_PORT ?? "19000", 10);
const apiOrigin = { host: "127.0.0.1", port: apiPort };
const webOrigin = { host: "127.0.0.1", port: webPort };
let shuttingDown = false;

function startChild(name, command, args, options) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "inherit", "inherit"]
  });

  child.on("exit", (code, signal) => {
    console.error(`${name} exited`, { code, signal });
    if (shuttingDown) return;
    process.exitCode = code ?? 1;
    process.kill(process.pid, "SIGTERM");
  });

  return child;
}

const api = startChild("sentinel-api", process.execPath, ["dist/server.js"], {
  cwd: "/app/apps/api",
  env: {
    ...process.env,
    PORT: String(apiPort)
  }
});

const web = startChild("sentinel-web", process.execPath, ["apps/web/server.js"], {
  cwd: "/app/web",
  env: {
    ...process.env,
    PORT: String(webPort),
    HOSTNAME: "127.0.0.1"
  }
});

function routeToWeb(req) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const pathname = new URL(req.url ?? "/", "http://sentinel.local").pathname;
  const acceptsHtml = String(req.headers.accept ?? "").includes("text/html");
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/" || pathname === "/setup") return true;
  if (pathname === "/brain" || pathname === "/services" || pathname === "/qdrant" || pathname === "/test-app") return acceptsHtml;
  if (pathname === "/incidents" || pathname.startsWith("/incidents/")) {
    return acceptsHtml;
  }
  return acceptsHtml && !pathname.startsWith("/api/");
}

function proxy(req, res, target) {
  const upstream = http.request(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: {
        ...req.headers,
        host: `${target.host}:${target.port}`
      }
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    }
  );

  upstream.on("error", (error) => {
    console.error("Proxy upstream failed", { target, error });
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: "Sentinel upstream unavailable" }));
  });

  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  proxy(req, res, routeToWeb(req) ? webOrigin : apiOrigin);
});

server.listen(publicPort, "0.0.0.0", () => {
  console.log(`Sentinel combined service listening on ${publicPort}`);
});

function shutdown() {
  shuttingDown = true;
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

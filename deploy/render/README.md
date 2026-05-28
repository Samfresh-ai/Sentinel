# Sentinel Render API Deployment

Render is viable for the Sentinel API. Keep the web app on Vercel or another
static/serverless-friendly host so the Render free instance hours are spent on
the API that receives Splunk webhooks and runs the agent.

## Accepted Shape

- `sentinel-api`: Docker web service from `apps/api/Dockerfile`, health check `/health`.
- `sentinel-web`: Vercel deployment from `apps/web`, with `NEXT_PUBLIC_API_URL` pointing to Render.
- Splunk target: Splunk Cloud, an externally reachable Splunk Enterprise host, or a protected tunnel to the verified local Splunk instance.

Do not deploy Sentinel production with `SPLUNK_HOST=localhost`. The runtime gate blocks that because the public API would not have the required path:

```text
app logs -> Splunk HEC -> Splunk saved search -> webhook -> Sentinel ACT/VERIFY/CLOSE
```

## Render Fit Notes

Render web services are a fit for `sentinel-api`: Docker builds are supported
and public HTTPS service URLs are generated.

Splunk is the hard part. A public Render web service forwards inbound traffic to
one HTTP port. Splunk needs HEC plus management/search/KV access for Sentinel,
and durable Splunk state needs persistent storage. Do not create a paid Render
private Splunk service without explicit approval. For the contest demo, a
Cloudflare named tunnel can expose only the required local Splunk routes while
Splunk Cloud verification is pending.

## Required API Variables

```text
NODE_ENV=production
OPERAIQ_RUNTIME_ENV=production
SENTINEL_MODE=true
AGENT_NAME=Sentinel
OPERAIQ_REMEDIATION_BACKEND=admin-endpoint
OPERAIQ_GENERATION_PROVIDER=nvidia
NVIDIA_API_KEY=<secret>
MONGODB_ATLAS_URI=<secret>
MONGODB_DATABASE_NAME=sentinel
JWT_SECRET=<secret>
WEBHOOK_SECRET=<secret>
AGENT_TOOL_SECRET=<secret>
PUBLIC_APP_URL=https://<sentinel-web>.onrender.com
NEXT_PUBLIC_API_URL=https://<sentinel-api>.onrender.com
AGENT_TOOL_EXECUTION_BASE_URL=https://<sentinel-api>.onrender.com
SPLUNK_HOST=localhost
SPLUNK_MGMT_URL=https://<protected-splunk-mgmt-host>
SPLUNK_HEC_URL=https://<protected-splunk-hec-host>
SPLUNK_MGMT_PORT=8089
SPLUNK_HEC_PORT=8088
SPLUNK_HEC_PROTOCOL=https
SPLUNK_USERNAME=<secret>
SPLUNK_PASSWORD=<secret>
SPLUNK_HEC_TOKEN=<secret>
SPLUNK_CF_ACCESS_CLIENT_ID=<optional-cloudflare-access-client-id>
SPLUNK_CF_ACCESS_CLIENT_SECRET=<optional-cloudflare-access-client-secret>
SPLUNK_APP=sentinel
SPLUNK_INDEX=sentinel
SPLUNK_DASHBOARD_URL=https://<splunk-web>/en-US/app/sentinel/sentinel_overview
```

## Required Web Variables

```text
NODE_ENV=production
OPERAIQ_RUNTIME_ENV=production
NEXT_PUBLIC_API_URL=https://<sentinel-api>.onrender.com
NEXT_PUBLIC_SPLUNK_DASHBOARD_URL=https://<splunk-web>/en-US/app/sentinel/sentinel_overview
```

## Manual Order

1. Create `sentinel-api` as a Docker web service using `apps/api/Dockerfile`.
2. Add all API variables. Generate random values for `JWT_SECRET`, `WEBHOOK_SECRET`, and `AGENT_TOOL_SECRET`.
3. Deploy `sentinel-web` on Vercel from `apps/web` and set `NEXT_PUBLIC_API_URL` to the Render API URL.
4. Open `/runtime/readiness` on the API. It must return `autonomous-ready`, not `production-blocked`.
5. Use the web setup screen to create the Sentinel org and copy the webhook URL into a Splunk saved search.
6. Run the strict acceptance proof from a real app log source: logs to HEC, Splunk saved search fires webhook, Sentinel reaches `ACT`, `VERIFY`, and `CLOSE`.

## Current Blocker

The local verified Splunk instance is `localhost`, which Render cannot use
directly. Deployment should pause before final submission until one of these is
true:

- Splunk Cloud credentials are available.
- A reachable external Splunk Enterprise host is available.
- A protected tunnel to local Splunk is running and supervised for the full demo window.

# Sentinel Render API Deployment

Render is viable as the single Sentinel service. The current simple shape is one
Docker web service that serves both the API and the built web UI.

## Accepted Shape

- `sentinel-api`: Docker web service from `apps/api/Dockerfile`, health check `/health`, serving both API routes and the Sentinel web UI.
- Splunk target: Splunk Cloud, an externally reachable Splunk Enterprise host, or a protected tunnel to the verified local Splunk instance.

Do not deploy Sentinel production with `SPLUNK_HOST=localhost`. The runtime gate blocks that because the public API would not have the required path:

```text
app logs -> Splunk HEC -> Splunk saved search -> webhook -> Sentinel ACT/VERIFY/CLOSE
```

## Render Fit Notes

Render web services are a fit for `sentinel-api`: Docker builds are supported
and public HTTPS service URLs are generated.

Splunk is the hard part. The simple production shape is Splunk Cloud plus the
single Render `sentinel-api` service. Use the local Cloudflare tunnel only while
Splunk Cloud access is still pending.

When the Splunk portal enables **Access Instance**, copy the stack host from the
Splunk Cloud URL and set `SPLUNK_CLOUD_STACK_HOST`. Sentinel derives:

- management API: `https://<stack-host>:8089`
- HEC on free trials: `https://http-inputs-<stack-host>:8088`

If Splunk shows a different HEC host, set `SPLUNK_HEC_URL` explicitly.

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
PUBLIC_APP_URL=https://<sentinel-api>.onrender.com
NEXT_PUBLIC_API_URL=https://<sentinel-api>.onrender.com
AGENT_TOOL_EXECUTION_BASE_URL=https://<sentinel-api>.onrender.com
SPLUNK_HOST=localhost
SPLUNK_CLOUD_STACK_HOST=<stack>.splunkcloud.com
SPLUNK_MGMT_URL=
SPLUNK_HEC_URL=
SPLUNK_MGMT_PORT=8089
SPLUNK_HEC_PORT=8088
SPLUNK_HEC_PROTOCOL=https
SPLUNK_USERNAME=<secret>
SPLUNK_PASSWORD=<secret>
SPLUNK_HEC_TOKEN=<secret>
SPLUNK_GATEWAY_TOKEN=
SPLUNK_CF_ACCESS_CLIENT_ID=
SPLUNK_CF_ACCESS_CLIENT_SECRET=
SPLUNK_APP=sentinel
SPLUNK_INDEX=sentinel
SPLUNK_DASHBOARD_URL=https://<splunk-web>/en-US/app/sentinel/sentinel_overview
```

## Manual Order

1. Create `sentinel-api` as a Docker web service using `apps/api/Dockerfile`.
2. Add all API variables. Generate random values for `JWT_SECRET`, `WEBHOOK_SECRET`, and `AGENT_TOOL_SECRET`.
3. Open `/runtime/readiness` on the API. It must return `autonomous-ready`, not `production-blocked`.
4. Use the web setup screen to create the Sentinel org and copy the webhook URL into a Splunk saved search.
5. Run the strict acceptance proof from a real app log source: logs to HEC, Splunk saved search fires webhook, Sentinel reaches `ACT`, `VERIFY`, and `CLOSE`.

## Cloud Cutover

1. In Splunk support, wait until the trial row has **Access Instance** enabled.
2. Open the instance and copy the stack host from the browser URL.
3. In Splunk Web, enable HEC and create a token for the `sentinel` index.
4. In Render, set `SPLUNK_CLOUD_STACK_HOST`, `SPLUNK_USERNAME`,
   `SPLUNK_PASSWORD`, and `SPLUNK_HEC_TOKEN`.
5. In Render, clear `SPLUNK_MGMT_URL`, `SPLUNK_HEC_URL`,
   `SPLUNK_GATEWAY_TOKEN`, `SPLUNK_CF_ACCESS_CLIENT_ID`, and
   `SPLUNK_CF_ACCESS_CLIENT_SECRET`.
6. Redeploy and verify `/runtime/readiness`, `pnpm splunk:setup-check`, and a
   live Splunk saved-search webhook.

## Current Blocker

The local verified Splunk instance is `localhost`, which Render cannot use
directly. Deployment should pause before final submission until one of these is
true:

- Splunk Cloud credentials are available.
- A reachable external Splunk Enterprise host is available.
- A protected tunnel to local Splunk is running and supervised for the full demo window.

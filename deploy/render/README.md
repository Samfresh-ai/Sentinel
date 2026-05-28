# Sentinel Render Deployment

Render is viable for Sentinel web/API, but only if Splunk is not local.

## Accepted Shape

- `sentinel-api`: Docker web service from `apps/api/Dockerfile`, health check `/health`.
- `sentinel-web`: Docker web service from `apps/web/Dockerfile`.
- Splunk target: Splunk Cloud, an externally reachable Splunk Enterprise host, or a paid Render private service with persistent disk and private-network access to ports `8088` and `8089`.

Do not deploy Sentinel production with `SPLUNK_HOST=localhost`. The runtime gate blocks that because the public API would not have the required path:

```text
app logs -> Splunk HEC -> Splunk saved search -> webhook -> Sentinel ACT/VERIFY/CLOSE
```

## Render Fit Notes

Render web services are a fit for `sentinel-api` and `sentinel-web`: Docker builds are supported, public HTTPS service URLs are generated, and services in one region can communicate on Render's private network.

Splunk is the hard part. A public Render web service forwards inbound traffic to one HTTP port. Splunk needs separate HEC and management endpoints for Sentinel, and durable Splunk state needs persistent storage. A Render private service can receive private network traffic on multiple ports, but persistent disks require a paid service. Do not create that paid Splunk service without explicit approval.

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
SPLUNK_HOST=<non-local-splunk-host>
SPLUNK_MGMT_PORT=8089
SPLUNK_HEC_PORT=8088
SPLUNK_HEC_PROTOCOL=https
SPLUNK_USERNAME=<secret>
SPLUNK_PASSWORD=<secret>
SPLUNK_HEC_TOKEN=<secret>
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
2. Add all API variables. Let Render generate `JWT_SECRET`, `WEBHOOK_SECRET`, and `AGENT_TOOL_SECRET` if creating by Blueprint, or create random secrets manually in the dashboard.
3. Create `sentinel-web` as a Docker web service using `apps/web/Dockerfile`.
4. Set `NEXT_PUBLIC_API_URL` to the public API URL after Render generates it.
5. Open `/runtime/readiness` on the API. It must return `autonomous-ready`, not `production-blocked`.
6. Use the web setup screen to create the Sentinel org and copy the webhook URL into a Splunk saved search.
7. Run the strict acceptance proof from a real app log source: logs to HEC, Splunk saved search fires webhook, Sentinel reaches `ACT`, `VERIFY`, and `CLOSE`.

## Current Blocker

The local verified Splunk instance is `localhost`, which Render cannot use. Deployment should pause until one of these is true:

- Splunk Cloud credentials are available.
- A reachable external Splunk Enterprise host is available.
- SAM approves a paid Render private Splunk service with persistent disk.

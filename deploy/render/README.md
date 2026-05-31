# Sentinel Render Deployment

Render can run Sentinel, but keep the web URL and API URL conceptually separate. The API is what Splunk calls. The live URL is what users and judges open.

## Preferred Shape

- `sentinel-api`: Docker web service from `apps/api/Dockerfile`, health check `/health`.
- `sentinel-web`: static/web service from `apps/web/Dockerfile` or another host, pointed at `sentinel-api`.
- Splunk target: Splunk Cloud, externally reachable Splunk Enterprise, or a protected tunnel to the verified local Splunk Enterprise instance.

The temporary combined shape still works because `apps/api/Dockerfile` serves the built web UI and API from one service, but do not depend on that as the final architecture if separate URLs are available.

## Required API Variables

```text
NODE_ENV=production
SENTINEL_RUNTIME_ENV=production
SENTINEL_MODE=true
AGENT_NAME=Sentinel
SENTINEL_REMEDIATION_BACKEND=admin-endpoint
SENTINEL_GENERATION_PROVIDER=nvidia
NVIDIA_API_KEY=<secret>
JWT_SECRET=<secret>
WEBHOOK_SECRET=<secret>
AGENT_TOOL_SECRET=<secret>
PUBLIC_APP_URL=https://<sentinel-live-url>
API_PUBLIC_URL=https://<sentinel-api-url>
NEXT_PUBLIC_API_URL=https://<sentinel-api-url>
AGENT_TOOL_EXECUTION_BASE_URL=https://<sentinel-api-url>
SPLUNK_APP=sentinel
SPLUNK_INDEX=sentinel
SPLUNK_DASHBOARD_URL=https://<splunk-web>/en-US/app/sentinel/sentinel_overview
```

Monitor both URLs with UptimeRobot or an equivalent external monitor:

```text
GET https://<sentinel-api-url>/health
GET https://<sentinel-live-url>/
```

## Splunk Enterprise AWS Gateway Target

For the verified AWS-hosted Splunk Enterprise gateway:

```text
SPLUNK_HOST=sentinel-gw.3.208.71.125.sslip.io
SPLUNK_MGMT_URL=https://sentinel-gw.3.208.71.125.sslip.io
SPLUNK_HEC_URL=https://sentinel-gw.3.208.71.125.sslip.io
SPLUNK_MGMT_PORT=8089
SPLUNK_HEC_PORT=8088
SPLUNK_HEC_PROTOCOL=https
SPLUNK_USERNAME=<secret>
SPLUNK_PASSWORD=<secret>
SPLUNK_HEC_TOKEN=<secret>
SPLUNK_GATEWAY_TOKEN=<secret>
SPLUNK_CF_ACCESS_CLIENT_ID=
SPLUNK_CF_ACCESS_CLIENT_SECRET=
```

Do not use `splunk.paysmat.xyz` for this proof path; that route currently returns Cloudflare 530.

## Splunk Cloud Cutover

Once Splunk Cloud access is available, use the Cloud stack instead of the local tunnel:

```text
SPLUNK_CLOUD_STACK_HOST=<stack>.splunkcloud.com
SPLUNK_USERNAME=<secret>
SPLUNK_PASSWORD=<secret>
SPLUNK_HEC_TOKEN=<secret>
SPLUNK_CA_CERT=<optional PEM CA if required>
SPLUNK_MGMT_URL=
SPLUNK_HEC_URL=
SPLUNK_GATEWAY_TOKEN=
SPLUNK_CF_ACCESS_CLIENT_ID=
SPLUNK_CF_ACCESS_CLIENT_SECRET=
```

Sentinel derives management API through Splunk Web and HEC on `:8088`. If Splunk provides separate REST/HEC endpoints, set `SPLUNK_MGMT_URL` and `SPLUNK_HEC_URL` explicitly.

## Readiness

Before submission:

1. Open `/runtime/readiness`; it must return `autonomous-ready`.
2. Run Splunk setup checks against the target Splunk instance.
3. Run the direct human-flow proof:

```bash
./node_modules/.bin/tsx --conditions=development scripts/sentinel-human-flow.ts
```

The required proof path is:

```text
app logs -> Splunk HEC -> Splunk saved search -> webhook -> Sentinel ACT/VERIFY/CLOSE
```

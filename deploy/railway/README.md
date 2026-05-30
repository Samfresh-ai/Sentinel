# Sentinel Railway Deployment

This is the Sentinel-only deployment path.

## Target Shape

- `sentinel-api`: Docker build from `apps/api/Dockerfile`, public HTTPS domain, health check `/health`.
- `sentinel-web`: Docker build from `apps/web/Dockerfile`, public HTTPS domain, points at `sentinel-api`.
- Splunk: use Splunk Cloud or a separately managed Splunk Enterprise target for production. A Railway Splunk container is acceptable for public proof only if it has persistent volumes for both `/opt/splunk/etc` and `/opt/splunk/var`, a real admin password, HEC enabled, and backups.

Railway is a fit for the web/API because it supports persistent services, monorepo services, custom Dockerfile paths, variables, generated public domains, and volumes:

- https://docs.railway.com/build-deploy
- https://docs.railway.com/deployments/monorepo
- https://docs.railway.com/builds/dockerfiles
- https://docs.railway.com/guides/volumes

Splunk Docker's official container path requires `SPLUNK_START_ARGS=--accept-license` and `SPLUNK_PASSWORD`, and persistent Splunk storage should include `/opt/splunk/etc` and `/opt/splunk/var`:

- https://help.splunk.com/splunk-enterprise/get-started/install-and-upgrade/9.2/install-splunk-enterprise-in-virtual-and-containerized-environments/deploy-and-run-splunk-enterprise-inside-a-docker-container
- https://splunk.github.io/docker-splunk/STORAGE_OPTIONS.html

## Railway Service Config

When creating the GitHub-backed services, set the config-as-code file path manually:

- `sentinel-api`: `/deploy/railway/sentinel-api.railway.json`
- `sentinel-web`: `/deploy/railway/sentinel-web.railway.json`

Generate one Railway domain for `sentinel-api` and one for `sentinel-web`.

## Required Production Variables

Set these on `sentinel-api`:

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
PUBLIC_APP_URL=https://<sentinel-web-domain>
API_PUBLIC_URL=https://<sentinel-api-domain>
NEXT_PUBLIC_API_URL=https://<sentinel-api-domain>
AGENT_TOOL_EXECUTION_BASE_URL=https://<sentinel-api-domain>
SPLUNK_HOST=<splunk-host>
SPLUNK_MGMT_PORT=8089
SPLUNK_HEC_PORT=8088
SPLUNK_HEC_PROTOCOL=https
SPLUNK_USERNAME=admin
SPLUNK_PASSWORD=<secret>
SPLUNK_HEC_TOKEN=<secret>
SPLUNK_APP=sentinel
SPLUNK_INDEX=sentinel
SPLUNK_DASHBOARD_URL=https://<splunk-web>/en-US/app/sentinel/sentinel_overview
```

`SPLUNK_HOST` must be reachable from the deployed API service. Do not use `localhost` in production unless Splunk is running inside the same container, which is not the accepted Sentinel deployment shape.

Set these on `sentinel-web`:

```text
NODE_ENV=production
SENTINEL_RUNTIME_ENV=production
NEXT_PUBLIC_API_URL=https://<sentinel-api-domain>
NEXT_PUBLIC_SPLUNK_DASHBOARD_URL=https://<splunk-web>/en-US/app/sentinel/sentinel_overview
```

Do not set these in production:

```text
SENTINEL_LOCAL_VERIFY=true
SENTINEL_TEST_REMEDIATION_WAIT_MS=...
SENTINEL_AI_PROVIDER=offline
SENTINEL_GENERATION_PROVIDER=offline
```

## Remediation Backend

For non-GCP deployment, Sentinel uses:

```text
SENTINEL_REMEDIATION_BACKEND=admin-endpoint
```

That means `scale_service`, `restart_pod`, `purge_cache`, and `rotate_connection_pool` call the affected service's configured:

```text
POST <adminBaseUrl>/admin/remediation
Authorization: Bearer <AGENT_TOOL_SECRET>
```

with JSON:

```json
{
  "action": "rotate_connection_pool",
  "targetService": "payment-service",
  "parameters": {},
  "requestedBy": "Sentinel",
  "publicAppUrl": "https://<sentinel-web-domain>"
}
```

This is intentionally fail-closed. If `service_runtime_configs.<service>.adminBaseUrl` is missing, Sentinel records a failed remediation instead of pretending an action happened.

## Autonomous Splunk Flow

The production acceptance path is:

```text
app logs -> Splunk HEC -> Splunk saved search -> webhook -> Sentinel ACT/VERIFY/CLOSE
```

The Splunk saved search must point to:

```text
https://<sentinel-api-domain>/webhooks/splunk-alert?orgId=<org-id>&secret=<shown-once-webhook-secret>
```

Use the Sentinel setup screen to create the org and get the webhook URL, then configure Splunk Alert Action with that exact URL.

## Rejected Deployment Shortcuts

- Vercel-only is not acceptable for full Sentinel because it does not host the stateful Splunk watcher.
- Railway web/API without real Splunk is not acceptable.
- A Splunk container without persistent `/opt/splunk/etc` and `/opt/splunk/var` is proof-only, not production.
- `SENTINEL_LOCAL_VERIFY=true` is proof mode only; production startup blocks it.

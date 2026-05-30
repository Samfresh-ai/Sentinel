# Sentinel

Sentinel is an autonomous incident response agent built around Splunk. The accepted production flow is:

```text
your app -> logs to Splunk HEC -> Splunk saved search watches patterns -> Splunk fires webhook -> Sentinel investigates, acts, verifies, closes, and writes a post-mortem
```

The dashboard is not a fake trigger surface. It shows incidents, reasoning, runbooks, service graph context, Splunk health, audit decisions, and post-mortems created by the Splunk-driven flow.

## What It Uses

- **Splunk Enterprise** for local testing and current proof runs. Local Enterprise provides HEC, SPL search, scheduled searches, KV Store memory, and the native Sentinel app/dashboard.
- **Splunk Cloud** for the hosted production target. The code supports Splunk Cloud management and HEC endpoints through `SPLUNK_CLOUD_STACK_HOST`, `SPLUNK_MGMT_URL`, `SPLUNK_HEC_URL`, and `SPLUNK_CA_CERT`.
- **Hosted model inference** is capability-gated. Local Splunk Enterprise does not expose Splunk Hosted Models, so Sentinel uses the configured generation fallback there. Splunk Cloud can use Hosted Models once the Cloud instance and provider are reachable.

Current honest state: the local Splunk Enterprise path is the verified test path. Splunk Cloud support is implemented, but the full cloud cutover still depends on reachable Cloud credentials/HEC and the Hosted Models capability being available.

## Architecture

```text
Application logs
        |
        v
Splunk HEC index=prod
        |
        v
Splunk saved search / Alert Action
        |
        v
POST /webhooks/splunk-alert?orgId=...&secret=...
        |
        v
Sentinel API
        |
        +--> Splunk KV Store: orgs, users, incidents, services, runbooks, audit, postmortems
        +--> SPL investigation against live logs
        +--> Remediation backend: admin endpoint or Cloud Run jobs
        +--> Slack/on-call notification when required
        |
        v
Sentinel web app + Splunk native dashboard
```

Sentinel is fail-closed: if a service has no runtime admin endpoint or Cloud Run target for an automatic action, the action is recorded as failed instead of pretending remediation happened.

## Local Setup

1. Install dependencies:

```bash
pnpm install
```

2. Copy env defaults:

```bash
cp .env.example .env
```

3. Configure Splunk Enterprise. See `SPLUNK_SETUP.md`.

4. Check Splunk:

```bash
pnpm splunk:setup-check
pnpm splunk:verify
```

5. Build:

```bash
pnpm typecheck
pnpm build
```

## Production URLs

Keep the public web URL and API URL separate when deploying two services:

```text
PUBLIC_APP_URL=https://<sentinel-live-url>
API_PUBLIC_URL=https://<sentinel-api-url>
NEXT_PUBLIC_API_URL=https://<sentinel-api-url>
AGENT_TOOL_EXECUTION_BASE_URL=https://<sentinel-api-url>
```

`PUBLIC_APP_URL` is what users open and what incident links point to. `API_PUBLIC_URL` / `NEXT_PUBLIC_API_URL` is what the browser, Splunk webhook URL generation, and remediation tools call.

If Render is temporarily running the combined web/API service, these values may point to the same host, but the preferred shape is one live web URL and one API URL. Use UptimeRobot or another monitor to keep both alive:

- `GET https://<sentinel-api-url>/health`
- `GET https://<sentinel-live-url>/`

## Render Deployment

See `deploy/render/README.md`.

Required production values:

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
```

For local Splunk Enterprise exposed through a protected tunnel:

```text
SPLUNK_HOST=splunk.paysmat.xyz
SPLUNK_MGMT_URL=https://splunk.paysmat.xyz
SPLUNK_HEC_URL=https://splunk.paysmat.xyz
SPLUNK_GATEWAY_TOKEN=<secret>
SPLUNK_USERNAME=<secret>
SPLUNK_PASSWORD=<secret>
SPLUNK_HEC_TOKEN=<secret>
```

For Splunk Cloud:

```text
SPLUNK_CLOUD_STACK_HOST=<stack>.splunkcloud.com
SPLUNK_USERNAME=<secret>
SPLUNK_PASSWORD=<secret>
SPLUNK_HEC_TOKEN=<secret>
SPLUNK_CA_CERT=<optional PEM CA if required by the stack>
SPLUNK_MGMT_URL=
SPLUNK_HEC_URL=
SPLUNK_GATEWAY_TOKEN=
SPLUNK_CF_ACCESS_CLIENT_ID=
SPLUNK_CF_ACCESS_CLIENT_SECRET=
```

## Fresh Human-Flow Proof

This is the acceptance test SAM asked for. It creates a new Sentinel org/project, seeds real Sentinel service/runbook config into Splunk KV Store, sends app logs to Splunk HEC, configures a real scheduled Splunk saved search, waits for Splunk to fire the webhook, then waits for Sentinel to ACT, VERIFY, CLOSE, and write a post-mortem.

It deliberately does not use a `pnpm sentinel:*` shortcut:

```bash
./node_modules/.bin/tsx --conditions=development scripts/sentinel-human-flow.ts
```

Pass criteria:

- app logs are indexed in Splunk
- Splunk saved search fires the Sentinel webhook
- Sentinel creates an incident for the new project
- Sentinel executes an action
- Sentinel verifies with SPL after action
- Sentinel closes the incident and writes a post-mortem

The script writes a local ignored proof file under `artifacts/runtime/`.

## Runtime Guardrails

Production startup blocks unsafe settings:

- local-only verification enabled
- offline generation in production
- local web/API URLs in production
- local Splunk endpoints in production
- missing Splunk credentials or HEC token
- missing remediation secret for admin-endpoint mode

Webhook and tool requests support Sentinel headers:

```text
x-sentinel-secret: <WEBHOOK_SECRET>
x-sentinel-tool-secret: <AGENT_TOOL_SECRET>
Authorization: Bearer <AGENT_TOOL_SECRET>
```

The Splunk Alert Action webhook uses the org-specific URL generated in the setup screen. The raw webhook secret is shown only inside that URL when created or rotated.

## Repository Notes

Some package names and env prefixes still use the original internal namespace for compatibility with the existing build graph. Do not use that older brand in Sentinel product copy, docs, dashboards, or submission material.

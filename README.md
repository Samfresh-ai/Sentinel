# Sentinel

Sentinel is a Splunk-native autonomous SRE incident response agent. It ingests app logs through Splunk HEC, lets Splunk saved searches watch for failure patterns, accepts Splunk Alert Action webhooks, investigates with SPL, acts through real remediation backends, streams reasoning in the web app, and writes post-mortems back into Splunk.

This repo still contains the older OperaIQ path, but Sentinel is the production focus. Keep public Sentinel deployments separate from OperaIQ by using `sentinel-*` service names, `SENTINEL_MODE=true`, and the Sentinel deployment docs in `deploy/railway/README.md` or `cloudbuild.sentinel.yaml`.

## Architecture

```text
PagerDuty / Datadog / Alertmanager
        |
        v
Express API /webhooks/alert
        |
        v
Google Pub/Sub: operaiq-alerts
        |
        v
OperaIQ agent runtime on Cloud Run / Vertex Agent Builder tool config
        |
        +--> MongoDB MCP Server --> MongoDB Atlas + Vector Search
        +--> Cloud Run Jobs: scale-service, restart-pod, purge-cache, rotate-connection-pool, notify-team
        +--> Slack Web API
        |
        v
Google Pub/Sub: operaiq-agent-events
        |
        v
Next.js UI via SSE
```

## Setup

1. `pnpm install`
2. `cp .env.example .env`
3. Fill in `MONGODB_ATLAS_URI`, `GOOGLE_CLOUD_PROJECT_ID`, `VERTEX_AI_LOCATION`, `SLACK_BOT_TOKEN`, `SLACK_DEFAULT_INCIDENT_CHANNEL`, `SLACK_SIGNING_SECRET`, and `WEBHOOK_SECRET`.
4. `pnpm preflight`
5. Set `PUBSUB_PUSH_ENDPOINT=https://<api-host>/pubsub/alerts` after the API is deployed to a public HTTPS URL, then run `pnpm setup:pubsub`.
6. `pnpm build`
7. `pnpm seed`
8. `docker compose up --build`
9. Open `http://localhost:3000`
10. `pnpm test-webhook`

If `pnpm install` fails, confirm Node is version 20 or newer and pnpm is enabled through Corepack; Node 22 is what the Dockerfiles use for the pinned pnpm 11 toolchain. If `pnpm preflight` fails, fill the missing variables it prints and confirm `gcloud`, Docker, Atlas, Pub/Sub, and Slack are reachable. Outside local verification mode, preflight calls Slack `auth.test` and `conversations.info` so a non-empty token is not enough. If `pnpm setup:pubsub` fails with a localhost endpoint, deploy the API first and set `PUBSUB_PUSH_ENDPOINT` to the public HTTPS `/pubsub/alerts` URL; Pub/Sub push subscriptions do not accept `http://localhost`. If `pnpm seed` fails, confirm Atlas allows your IP, the project has billing enabled, and Google Application Default Credentials can call Vertex AI. If `docker compose up` fails, confirm Docker is running and ports 3000 and 3001 are free.

For zero-billing local verification, keep production defaults unchanged and run checks with explicit local flags:

```bash
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true pnpm preflight
OPERAIQ_AI_PROVIDER=offline pnpm brain:test
OPERAIQ_AI_PROVIDER=offline pnpm seed:verify
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm agent:smoke-test
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_LOCAL_PUBSUB_DIRECT=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm verify:e2e
```

`OPERAIQ_AI_PROVIDER=offline` uses deterministic local embeddings and deterministic generated fields for verification only. `OPERAIQ_LOCAL_VERIFY=true` skips production Slack readiness checks and records remediation without dispatching Cloud Run. `OPERAIQ_LOCAL_PUBSUB_DIRECT=true` lets the e2e script deliver the Pub/Sub payload to the local API because Google Pub/Sub cannot push to localhost.

To use a free hosted model for generated runbooks, incident conclusions, and post-mortem fields while keeping local/offline embeddings, set:

```bash
OPERAIQ_AI_PROVIDER=offline
OPERAIQ_GENERATION_PROVIDER=nvidia
NVIDIA_API_KEY=<redacted>
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MODEL=nvidia/llama-3.1-nemotron-nano-8b-v1
```

The same code also supports any OpenAI-compatible endpoint through `OPERAIQ_GENERATION_PROVIDER=openai-compatible` plus `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, and `OPENAI_COMPATIBLE_MODEL`. Do not set `OPERAIQ_AI_PROVIDER=nvidia`; embeddings still use `vertex` or `offline`.

## Running Sentinel

Sentinel is the Splunk-native path. It lives alongside OperaIQ in the same monorepo, but public deployments should treat it as a separate product. The agent loop, UI, and API server stay shared; the Sentinel platform layer is Splunk KV Store, SPL/HEC, the Splunk Alert Action webhook, and either a Cloud Run or admin-endpoint remediation backend.

After completing the OperaIQ setup, Sentinel needs three additional steps:

1. Install and license Splunk Enterprise 9.x locally. See `SPLUNK_SETUP.md`.
2. Copy Splunk credentials and the HEC token into `.env`.
3. Run `pnpm splunk:setup-check`, then `pnpm splunk:seed`.

Sentinel listens at `POST /webhooks/splunk-alert`. OperaIQ still listens at `POST /webhooks/alert`. Both can run from the same `docker compose up --build` process once their backing services are configured.

Sentinel has three intentionally separate proof phases:

1. Demo fast path: `pnpm sentinel:demo`
   - Purpose: quick judge/operator reproduction.
   - Path: sends logs, seeds demo brain, then posts a Splunk-shaped webhook directly.
   - Mode: local verification is allowed; it proves the Sentinel loop and UI, not real infrastructure remediation.
2. Autonomous demo: `pnpm sentinel:demo:setup` then `pnpm sentinel:demo:logs`
   - Purpose: prove Splunk watches without a manual trigger.
   - Path: app logs go to HEC, Splunk saved search runs on schedule, Splunk fires `/webhooks/splunk-alert`, Sentinel acts.
   - Mode: local verification is allowed; the watcher/webhook path is real, the remediation dispatch may still be recorded locally.
3. Strict human-flow run
   - Purpose: acceptance proof for `[app] -> Splunk -> saved search -> webhook -> Sentinel ACT/VERIFY/CLOSE`.
   - Path: fresh org/project, direct Splunk REST/HEC setup, real saved-search scheduler, no `pnpm sentinel:*` shortcut.
   - Latest proof: `artifacts/human-flow/splunk-autonomous-flow-20260527182942.json`.

Sentinel verification commands for local development:

```bash
pnpm splunk:setup-check
pnpm splunk:hosted-models-check
pnpm splunk:seed
pnpm splunk:verify
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:test-tools
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:smoke-test
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:e2e
```

Splunk Hosted Models require the Splunk AI Toolkit path, not the older `genai` / `llmgenerate` names. Sentinel probes Hosted Models at startup with `probeHostedModels()`: local Splunk Enterprise uses Gemini fallback, while Splunk Cloud Platform can activate Hosted Models automatically when the probe succeeds. The Splunk-native parts remain KV Store memory, SPL investigation, HEC indexing, and Splunk Alert Action triggering.

### Sentinel Production Readiness

Production Sentinel must be deployed separately from OperaIQ.

Preferred non-GCP path for Sentinel web/API: Railway with `deploy/railway/sentinel-api.railway.json` and `deploy/railway/sentinel-web.railway.json`, or Render with the constraints in `deploy/render/README.md`. Use Splunk Cloud or a separately managed Splunk Enterprise target for production Splunk. A platform-hosted Splunk container is demo-only unless it has persistent `/opt/splunk/etc`, persistent `/opt/splunk/var`, backups, a real HEC token, and enough memory/disk for Splunk.

Google Cloud remains supported through `cloudbuild.sentinel.yaml`; it builds the same shared code but publishes Cloud Run services and jobs under `sentinel-*` names instead of `operaiq-*`:

```bash
gcloud builds submit --config cloudbuild.sentinel.yaml --substitutions _REGION=us-central1
```

Before a public deployment can be considered production-ready:

- `OPERAIQ_RUNTIME_ENV=production`
- `SENTINEL_MODE=true`
- `AGENT_NAME=Sentinel`
- `OPERAIQ_REMEDIATION_BACKEND=admin-endpoint` for Railway/Render/Fly, or `cloud-run` for Google Cloud
- `CLOUD_RUN_REMEDIATION_JOB_PREFIX=sentinel-remediate` when using the Cloud Run backend
- `OPERAIQ_LOCAL_VERIFY=false`
- `DEMO_REMEDIATION_WAIT_MS` unset
- `OPERAIQ_AI_PROVIDER` and `OPERAIQ_GENERATION_PROVIDER` not `offline`
- `PUBLIC_APP_URL`, `NEXT_PUBLIC_API_URL`, and `AGENT_TOOL_EXECUTION_BASE_URL` set to public HTTPS Sentinel URLs
- `SPLUNK_HOST` set to a reachable non-local Splunk Enterprise or Splunk Cloud host, with `SPLUNK_USERNAME`, `SPLUNK_PASSWORD`, and `SPLUNK_HEC_TOKEN` configured
- service runtime configs contain real `adminBaseUrl` values for the admin-endpoint backend, or Cloud Run service names for the Cloud Run backend

The API refuses production startup when fake-action flags, demo-timing flags, local public URLs, or a local/missing Splunk target are present. The web app also exposes the current runtime gate on the Brain screen so a user can see `Local verification`, `Demo timing`, `Autonomous ready`, or `Production blocked` instead of mistaking demo proof for prod.

## Environment

| Variable | Description |
| --- | --- |
| `MONGODB_ATLAS_URI` | Full MongoDB Atlas connection string with credentials. |
| `MONGODB_DATABASE_NAME` | Database name, default `operaiq`. |
| `GOOGLE_CLOUD_PROJECT_ID` | Required when using Vertex AI generation/embeddings or the Cloud Run remediation backend. Not required for Sentinel-only Railway deployment with `OPERAIQ_GENERATION_PROVIDER=nvidia` and `OPERAIQ_REMEDIATION_BACKEND=admin-endpoint`. |
| `GOOGLE_CLOUD_REGION` | Cloud Run region, default `us-central1`. |
| `VERTEX_AI_LOCATION` | Vertex AI location, default `us-central1`. |
| `OPERAIQ_AI_PROVIDER` | `vertex` for production, `offline` for local zero-billing verification. |
| `OPERAIQ_GENERATION_PROVIDER` | Optional text-generation override: `vertex`, `offline`, `nvidia`, or `openai-compatible`. |
| `NVIDIA_API_KEY` | NVIDIA Build/NIM API key for free hosted generation; keep it only in `.env`. |
| `NVIDIA_BASE_URL` | NVIDIA OpenAI-compatible base URL, default `https://integrate.api.nvidia.com/v1`. |
| `NVIDIA_MODEL` | NVIDIA model ID, default `nvidia/llama-3.1-nemotron-nano-8b-v1`. |
| `OPENAI_COMPATIBLE_API_KEY` | Generic OpenAI-compatible generation API key. |
| `OPENAI_COMPATIBLE_BASE_URL` | Generic OpenAI-compatible generation base URL. |
| `OPENAI_COMPATIBLE_MODEL` | Generic OpenAI-compatible generation model ID. |
| `AGENT_BUILDER_AGENT_ID` | Agent Builder ID after deployment. |
| `PUBSUB_ALERT_TOPIC` | Alert topic, default `operaiq-alerts`. |
| `PUBSUB_EVENTS_TOPIC` | Reasoning event topic, default `operaiq-agent-events`. |
| `PUBSUB_ALERT_PUSH_SUBSCRIPTION` | Push subscription that calls `/pubsub/alerts`. |
| `PUBSUB_EVENTS_SUBSCRIPTION` | Pull subscription used by the SSE bridge. |
| `PUBSUB_PUSH_ENDPOINT` | Public HTTPS API endpoint ending in `/pubsub/alerts`; required by `pnpm setup:pubsub`. |
| `PUBSUB_PUSH_SERVICE_ACCOUNT` | Service account email used by Pub/Sub push OIDC tokens. |
| `PUBSUB_PUSH_AUDIENCE` | Expected Pub/Sub push token audience; defaults to `PUBSUB_PUSH_ENDPOINT`. |
| `PUBSUB_PUSH_AUTH_REQUIRED` | Set `true` in production after OIDC push auth is configured. |
| `SLACK_BOT_TOKEN` | Slack bot token with `chat:write`. |
| `SLACK_DEFAULT_INCIDENT_CHANNEL` | Slack channel ID for incident updates. |
| `SLACK_SIGNING_SECRET` | Slack app signing secret for approval interactions. |
| `SPLUNK_HOST` | Splunk Enterprise host for Sentinel, default `localhost`. |
| `SPLUNK_CLOUD_STACK_HOST` | Preferred hosted Splunk Cloud stack host from Access Instance; Sentinel derives management and HEC endpoints from it. |
| `SPLUNK_MGMT_URL` | Optional full Splunk management URL; overrides `SPLUNK_CLOUD_STACK_HOST`. |
| `SPLUNK_HEC_URL` | Optional full Splunk HEC base URL; overrides `SPLUNK_CLOUD_STACK_HOST`. |
| `SPLUNK_MGMT_PORT` | Splunk management API port, default `8089`. |
| `SPLUNK_HEC_PORT` | Splunk HTTP Event Collector port, default `8088`. |
| `SPLUNK_HEC_PROTOCOL` | HEC protocol, default `https`; local self-signed validation is relaxed only for localhost. |
| `SPLUNK_USERNAME` | Splunk REST username, usually `admin` locally. |
| `SPLUNK_PASSWORD` | Splunk REST password; redacted by logger. |
| `SPLUNK_HEC_TOKEN` | HEC token for writing Sentinel events. |
| `SPLUNK_APP` | Splunk app namespace for KV Store, default `sentinel`. |
| `SPLUNK_INDEX` | Splunk event index for Sentinel, default `sentinel`. |
| `AGENT_NAME` | Agent identity; `OperaIQ` by default, `Sentinel` for Sentinel scripts/runtime. |
| `SENTINEL_MODE` | Enables Sentinel data-source behavior inside shared tools. |
| `OPERAIQ_RUNTIME_ENV` | Set `production` for public deployments; production mode blocks local verification and demo timing flags. |
| `OPERAIQ_REMEDIATION_BACKEND` | `cloud-run` for Google Cloud remediation jobs, or `admin-endpoint` for Railway/Render/Fly deployments that call real service admin endpoints. |
| `PORT` | API port, default `3001`. |
| `WEBHOOK_SECRET` | Shared secret checked on alert webhooks. |
| `AGENT_TOOL_SECRET` | Bearer token for Agent Builder tool execution. Defaults to `WEBHOOK_SECRET` when unset. |
| `AGENT_TOOL_EXECUTION_BASE_URL` | Public API base URL Agent Builder uses for tool calls. Defaults to `PUBLIC_APP_URL`. |
| `PUBLIC_APP_URL` | Public web URL used in Slack links. |
| `NEXT_PUBLIC_API_URL` | Browser-visible API base URL. |
| `OPERAIQ_REMEDIATION_WAIT_MS` | Wait between remediation steps; production default is 30000. |
| `OPERAIQ_LOCAL_VERIFY` | Set `true` only for local verification to skip Slack preflight and Cloud Run remediation dispatch. |
| `OPERAIQ_LOCAL_PUBSUB_DIRECT` | Set `true` only for local `verify:e2e` so the script calls `/pubsub/alerts` directly after webhook creation. |
| `CLOUD_RUN_REMEDIATION_JOB_PREFIX` | Prefix for per-action Cloud Run jobs, default `operaiq-remediate`. |
| `LOG_LEVEL` | Pino log level, default `info`. |
| `MONGODB_MCP_SERVER_COMMAND` | Optional override for the MongoDB MCP server executable. |
| `MDB_MCP_LOG_PATH` | MongoDB MCP server log path, default `/tmp/operaiq-mongodb-mcp`. |
| `OPERAIQ_*_ADMIN_BASE_URL` | Optional per-service admin base URLs loaded into `service_runtime_configs` by `pnpm seed`. |
| `OPERAIQ_*_CLOUD_RUN_SERVICE_NAME` | Optional per-service Cloud Run service names loaded into `service_runtime_configs` by `pnpm seed`. |

## MongoDB Atlas

Create an Atlas M0 or M10 cluster, allow your development IP, create a database user, and set `MONGODB_ATLAS_URI`. Run `pnpm seed`; it creates the five required brain collections, the `remediation_executions` audit collection, the `service_runtime_configs` operational collection, regular indexes, and seed documents. Atlas Vector Search indexes use 768 dimensions and cosine similarity:

```javascript
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 768,
      "similarity": "cosine"
    }
  ]
}
```

Create these vector indexes in Atlas:

- `incidents.embedding` as `incident_vector_index`
- `runbooks.embedding` as `runbook_vector_index`
- `patterns.embedding` as `pattern_vector_index`

The incident vector index must also include `status` as a filter field because resolved-incident search filters by status. The runbook vector index must include `applicableServices` as a filter field because runbook search filters by affected service. `pnpm seed` and app startup update existing Atlas Vector Search indexes when those filter fields are missing, then wait until Atlas reports the index as queryable.

The code also attempts to create them through the MongoDB driver where Atlas permits it.

The `services` collection is kept to the exact brain schema. Deployment-specific values such as service admin endpoints, Cloud Run service names, and incident channels live in `service_runtime_configs`, keyed by `serviceName`. `pnpm seed` writes null runtime targets unless the matching `OPERAIQ_*_ADMIN_BASE_URL` and `OPERAIQ_*_CLOUD_RUN_SERVICE_NAME` variables are set. `execute_remediation` reads `services` for owners and dependency context, then reads `service_runtime_configs` for real remediation targets before dispatching a Cloud Run job. Low-risk actions that require a missing runtime target fail and are logged rather than calling placeholder infrastructure.

## Google Cloud

Enable Vertex AI, Pub/Sub, Cloud Run Admin, Cloud Build, Artifact Registry, and Agent Builder related APIs.

Create Pub/Sub resources:

```bash
pnpm setup:pubsub
```

The setup script creates `PUBSUB_ALERT_TOPIC`, `PUBSUB_EVENTS_TOPIC`, `PUBSUB_ALERT_PUSH_SUBSCRIPTION`, and `PUBSUB_EVENTS_SUBSCRIPTION`. `PUBSUB_PUSH_ENDPOINT` must be a public HTTPS URL ending in `/pubsub/alerts`; the script rejects localhost because Google Pub/Sub cannot push to it. When `PUBSUB_PUSH_SERVICE_ACCOUNT` is set, the alert push subscription is created with an OIDC token. Set `PUBSUB_PUSH_AUDIENCE` to the same HTTPS endpoint and `PUBSUB_PUSH_AUTH_REQUIRED=true` on the API service for production push verification.

Runtime IAM:

- `roles/aiplatform.user`
- `roles/pubsub.publisher`
- `roles/pubsub.subscriber`
- `roles/run.admin`
- `roles/iam.serviceAccountUser`
- `roles/logging.logWriter`

Cloud Run jobs:

- `operaiq-remediate-scale-service`
- `operaiq-remediate-restart-pod`
- `operaiq-remediate-purge-cache`
- `operaiq-remediate-rotate-connection-pool`
- `operaiq-remediate-notify-team`

All five jobs use the image built from `packages/agent/Dockerfile.remediation`. `execute_remediation` does not run remediation inline; it starts the matching Cloud Run job and waits for the job operation to complete. The job runner performs the actual Cloud Run service update, admin endpoint call, or Slack API call.

Agent Builder tool execution:

- `GET /agent/openapi.json` returns the OpenAPI document for the five tool endpoints.
- `GET /agent/tools` returns the same tool definitions used by `packages/agent/src/agent-config.ts`.
- `POST /agent/tools/search_similar_incidents`
- `POST /agent/tools/get_service_dependency_graph`
- `POST /agent/tools/get_runbook`
- `POST /agent/tools/execute_remediation`
- `POST /agent/tools/write_postmortem`

Tool POST requests require `Authorization: Bearer <AGENT_TOOL_SECRET>` or `x-operaiq-tool-secret: <AGENT_TOOL_SECRET>`.

`packages/agent/src/agent-config.ts` emits the tool configuration and deployment command scaffold. `cloudbuild.yaml` deploys OperaIQ services under `operaiq-*`; `cloudbuild.sentinel.yaml` deploys Sentinel services under `sentinel-*` so the public Sentinel deployment is not mixed with OperaIQ. In the current verification workspace, `gcloud` is installed and Pub/Sub/Vertex APIs were enabled on a fresh project, but Cloud Run deployment remains blocked until billing is enabled.

## PagerDuty and Datadog

PagerDuty: create a webhook subscription pointing to `https://<api-host>/webhooks/alert`, include `x-operaiq-secret: <WEBHOOK_SECRET>`, and send incident trigger events.

Datadog: create a monitor webhook integration pointing to `https://<api-host>/webhooks/alert`, include `x-operaiq-secret: <WEBHOOK_SECRET>`, and send monitor alert payloads.

## Current Verification State

No live deployment URL was created in this workspace. Atlas is configured, Pub/Sub topics exist, and Slack is wired locally: the bot token validates as `operaiq` in workspace `OperaIQ`, `#all-operaiq` is reachable, a test message posted successfully, and the signing secret is stored in `.env` for interaction verification. Sentinel's separate Cloud Run config is ready in `cloudbuild.sentinel.yaml`, but the configured Google Cloud project `operaiq-1779637729` currently reports `billingEnabled=false`, so a public Sentinel URL cannot be created from this workspace yet. Pub/Sub push setup still needs a public HTTPS Sentinel API URL ending in `/pubsub/alerts`.

## Production Notes

The official `@mongodb-js/mongodb-mcp-server` package required by the build currently publishes a caution that it is a work in progress. OperaIQ uses it because the architecture contract requires the official MongoDB MCP server, and this caveat is carried into `VERIFICATION.md`.

This repository creates and updates MongoDB collection validators during startup/test setup. The Atlas database user used for verification therefore needs schema/index administration privileges, not only document read/write privileges. For a production deployment, split this into a migration identity and a lower-privilege runtime identity before handling real incidents.

Current container verification builds the API and remediation images under the original 200 MB target: `operaiq-api:test` is 195 MB and `operaiq-remediation:test` is 189 MB. The images use distroless Node 22 plus production `pnpm deploy`; the Dockerfiles prune runtime-unneeded source maps, TypeScript source/declaration files, docs, tests, examples, and top-level source/config files after deploy.

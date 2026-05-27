# OperaIQ Verification

Generated on 2026-05-25.

## 1. End-to-End Flow

`pnpm verify:e2e` now passes in explicit local-verification mode:

```bash
OPERAIQ_AI_PROVIDER=offline \
OPERAIQ_LOCAL_VERIFY=true \
OPERAIQ_LOCAL_PUBSUB_DIRECT=true \
OPERAIQ_REMEDIATION_WAIT_MS=0 \
pnpm verify:e2e
```

```text
PASSED verify:e2e - End-to-end flow: PASSED
```

What was proven:

- MongoDB Atlas connection succeeds with the local `.env`.
- The Atlas cluster accepts collection creation, collection validator updates, normal indexes, and Atlas Vector Search index creation/update.
- Atlas Vector Search indexes include required filter fields: `incidents.status` and `runbooks.applicableServices`.
- Pub/Sub API is enabled on `operaiq-1779637729`.
- Pub/Sub topics `operaiq-alerts` and `operaiq-agent-events` exist.
- The local API starts and `GET /health` returned `{"status":"ok","brainSize":33}` during the latest container smoke.
- `pnpm verify:e2e` creates its temporary Pub/Sub event subscription after fixing the 24-hour minimum expiration policy.
- The webhook path creates an incident, local Pub/Sub direct delivery runs the agent, agent events are published, remediation is recorded, a post-mortem is written, and the incident resolves.

Current blockers:

- Production Vertex AI/Agent Platform embedding calls still require active billing on `operaiq-1779637729`.
- Google Cloud billing cannot be enabled on the current Gmail because all visible billing accounts are closed.
- The zero-dollar workaround is intentionally local-only: `OPERAIQ_AI_PROVIDER=offline` uses deterministic 768-dim embeddings and deterministic Gemini substitutes; `OPERAIQ_LOCAL_VERIFY=true` skips Slack checks and Cloud Run dispatch while still recording remediation; `OPERAIQ_LOCAL_PUBSUB_DIRECT=true` lets the e2e script deliver the Pub/Sub payload to the local API.
- Slack install/token/channel wiring is complete for the current workspace. The bot token validates as `operaiq`, `#all-operaiq` is reachable, a wiring-check message posted successfully, and `SLACK_SIGNING_SECRET` is stored in local `.env` without being printed.
- Pub/Sub push subscription setup requires a public HTTPS API endpoint in `PUBSUB_PUSH_ENDPOINT`; localhost is correctly rejected.

No production fallback was added: default `OPERAIQ_AI_PROVIDER=vertex` still uses Vertex AI, production remediation still dispatches Cloud Run jobs, and `setup:pubsub` still rejects localhost push endpoints.

## 2. UI Verification

Does the agent reasoning panel stream steps in real time, or does it load all at once?

The code implements real-time SSE at `GET /incidents/:id/stream`, backed by the `operaiq-agent-events` Pub/Sub topic. The event publication path is now covered by local `verify:e2e`; browser-level SSE rendering is still not separately verified.

Do severity badges have distinct, immediately recognizable colors?

Yes in code: P1 red, P2 orange, P3 yellow, P4 muted dark.

Is the brain size counter live and accurate?

The API health endpoint returned `brainSize: 33` against the live Atlas database during the latest container smoke. The web feed fetches `/brain/stats` and refreshes every 10 seconds. Browser-level UI accuracy is not verified in this pass.

Does the "Simulate Incident" form on `/brain` actually trigger a real agent run?

The form posts to `/simulate`, which uses the same real incident creation and Pub/Sub path. The underlying local agent path now passes in local-verification mode; production execution still needs Vertex billing and Cloud Run.

Load the app on a 1280px screen. Does anything overflow, clip, or look broken?

Not runtime-verified in browser during this pass. `pnpm build` passed for the Next.js app.

## 3. Shipped vs Partial vs Imagined

| Feature | Shipped (works for real) | Partial (works in code or blocked by external config) | Imagined (described but not built) |
| --- | --- | --- | --- |
| Webhook ingestion | Yes in local verification; production route creates incidents and publishes Pub/Sub | Production processing still needs public push + Vertex/Cloud Run |  |
| MongoDB vector search | Yes: Atlas vector round-trip passes with local embeddings | Production embeddings still need Vertex billing |  |
| Agent tool: search_similar_incidents | Yes: local tool test passes through MongoDB MCP + Atlas Vector Search | Production embeddings still need Vertex billing |  |
| Agent tool: get_service_dependency_graph | Yes: local tool test passes through MongoDB MCP |  |  |
| Agent tool: execute_remediation | Yes in local verification: remediation is recorded and Cloud Run dispatch is skipped explicitly | Production dispatch still needs Cloud Run API/billing |  |
| Agent tool: write_postmortem | Yes: local tool test writes post-mortem and updates incident memory | Production embeddings still need Vertex billing |  |
| Agent tool: get_runbook | Yes: local tool test retrieves the S3 runbook | Generated runbook path still depends on production AI when not offline |  |
| Runbook auto-generation + save | Yes in code with BSON-safe driver writes | Production generated output still needs Vertex billing |  |
| SSE real-time reasoning stream | Events are published during local e2e | Browser SSE rendering still not separately verified |  |
| Slack notification | Yes: Slack `auth.test` passed, `#all-operaiq` is reachable, and a wiring-check message posted successfully | Production notification from a deployed Cloud Run job still needs Cloud Run billing |  |
| Slack approval flow | Signature verification is locally proven with `SLACK_SIGNING_SECRET`; Block Kit approval route exists | Full click-through approval needs a public HTTPS API URL configured in Slack interactivity |  |
| Post-mortem generation |  | Yes: implementation exists; waits on Vertex billing |  |
| Brain embedding update post-resolution |  | Yes: implementation exists; waits on Vertex billing |  |
| Cloud Run deployment |  | Yes: Dockerfiles/cloudbuild/job code exist; billing blocks deployment |  |
| Docker compose local setup |  | Yes: images now build locally; full production-mode compose runtime still waits on Vertex billing and public push URL |  |

Notes:

- "Shipped" here means the behavior is proven locally against real Atlas/Pub/Sub/Slack where possible. Production still depends on billing and public HTTPS deployment state.
- The official MongoDB MCP package required by the architecture currently publishes a work-in-progress caution. That is still a production caveat.
- `execute_remediation` dispatches one of five per-action Cloud Run jobs (`scale-service`, `restart-pod`, `purge-cache`, `rotate-connection-pool`, `notify-team`) instead of running remediation inline.
- In local verification mode only, `execute_remediation` records the selected action and skips Cloud Run dispatch.
- The required `services` collection stays on the exact brain schema. Remediation target details live in `service_runtime_configs`.
- `setup:pubsub` now rejects localhost push endpoints with a clear error instead of relying on Pub/Sub's generic invalid-endpoint failure.
- The Atlas verification user was upgraded to `atlasAdmin@admin` because schema/index setup uses `collMod`. For production, split migration privileges from runtime app privileges.
- Dockerfiles now use Node 22 because the pinned pnpm 11 toolchain failed under the earlier Node 20 base image.
- `.dockerignore` now keeps Docker contexts small; the build context is about 689 kB instead of hundreds of MB.
- The API and remediation runtime images now use distroless Node 22 plus `pnpm deploy --prod --no-optional`. Runtime-unneeded source maps, TypeScript source/declaration files, markdown/docs, tests, examples, and top-level source/config files are pruned after deploy. The API image is 195 MB and the remediation image is 189 MB, so both satisfy the original under-200MB target.

## 4. Proof Commands

Passed:

```text
pnpm typecheck
pnpm build
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true pnpm preflight
OPERAIQ_LOCAL_VERIFY=false OPERAIQ_AI_PROVIDER=offline pnpm preflight
OPERAIQ_AI_PROVIDER=offline pnpm brain:test
OPERAIQ_AI_PROVIDER=offline pnpm seed:verify
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm agent:test-tools
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm agent:smoke-test
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_LOCAL_PUBSUB_DIRECT=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm test-webhook
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_LOCAL_PUBSUB_DIRECT=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm verify:e2e
process.env documentation check: PASSED
MongoDB Atlas ping: PASSED
docker build -f packages/agent/Dockerfile.remediation -t operaiq-remediation:test .
docker build -f apps/api/Dockerfile -t operaiq-api:test .
docker build -f apps/web/Dockerfile -t operaiq-web:test .
Slack signature verification with stored `SLACK_SIGNING_SECRET`: PASSED
API container `/health`: PASSED with `brainSize=33`
API image module import: PASSED
Remediation image module import: PASSED
```

`OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true pnpm preflight`:

```text
PASS env:MONGODB_ATLAS_URI
PASS env:GOOGLE_CLOUD_PROJECT_ID
PASS env:WEBHOOK_SECRET
PASS env:NEXT_PUBLIC_API_URL
PASS gcloud
PASS docker-daemon
PASS mongodb-atlas
PASS pubsub-alert-topic
PASS pubsub-events-topic
PASS vertex-ai - skipped because OPERAIQ_AI_PROVIDER=offline
PASS slack - skipped because OPERAIQ_LOCAL_VERIFY=true
```

`OPERAIQ_LOCAL_VERIFY=false OPERAIQ_AI_PROVIDER=offline pnpm preflight`:

```text
PASS env:MONGODB_ATLAS_URI
PASS env:GOOGLE_CLOUD_PROJECT_ID
PASS env:WEBHOOK_SECRET
PASS env:NEXT_PUBLIC_API_URL
PASS env:SLACK_BOT_TOKEN
PASS env:SLACK_DEFAULT_INCIDENT_CHANNEL
PASS env:SLACK_SIGNING_SECRET
PASS gcloud
PASS docker-daemon
PASS mongodb-atlas
PASS pubsub-alert-topic
PASS pubsub-events-topic
PASS vertex-ai - skipped because OPERAIQ_AI_PROVIDER=offline
PASS slack - operaiq authenticated in OperaIQ; #all-operaiq is reachable
```

Local verification protocol commands:

| Command | Result | Observed output |
| --- | --- | --- |
| `OPERAIQ_AI_PROVIDER=offline pnpm brain:test` | PASSED | MongoDB connection and Atlas Vector Search round-trip succeeded with score `0.848`. |
| `OPERAIQ_AI_PROVIDER=offline pnpm seed:verify` | PASSED | Seed counts are correct and database connection timeout returns 3+ vector matches. |
| `OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm agent:test-tools` | PASSED | All 5 tools returned valid non-empty results. |
| `OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm agent:smoke-test` | PASSED | Status `resolved`; called search, graph, runbook, remediation, and postmortem tools. |
| `OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_LOCAL_PUBSUB_DIRECT=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm test-webhook` | PASSED | Created incident and returned Pub/Sub message ID. |
| `OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_LOCAL_PUBSUB_DIRECT=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm verify:e2e` | PASSED | End-to-end flow passed. |
| `pnpm setup:pubsub` | FAILED | Correctly rejects `http://localhost:3001`; needs `PUBSUB_PUSH_ENDPOINT=https://<api-host>/pubsub/alerts`. |

Container check:

| Command | Result | Observed output |
| --- | --- | --- |
| `docker info` / Docker preflight | PASSED | Docker daemon is running. Docker still prints a missing buildx plugin warning and falls back to the legacy builder. |
| `docker build -f packages/agent/Dockerfile.remediation -t operaiq-remediation:test .` | PASSED | Image `operaiq-remediation:test`, size 189 MB. |
| `docker build -f apps/api/Dockerfile -t operaiq-api:test .` | PASSED | Image `operaiq-api:test`, size 195 MB. |
| `docker build -f apps/web/Dockerfile -t operaiq-web:test .` | PASSED | Image `operaiq-web:test`, size 295 MB. |
| API container health check | PASSED | `/health` returned `status=ok` and `brainSize=33`. |
| Remediation image import check | PASSED | `dist/remediation-job.js` imports cleanly and no longer imports `dotenv/config` at runtime. |

External setup attempted:

- Installed Google Cloud SDK locally.
- Authenticated `adamolekuntemitope4@gmail.com` for gcloud and Application Default Credentials.
- Created Google Cloud project `operaiq-1779637729`.
- Enabled `aiplatform.googleapis.com` and `pubsub.googleapis.com`.
- Could not enable Cloud Run / Cloud Build / Artifact Registry on the new project because billing is not enabled.
- Tried enabling billing in browser; Google showed "No active billing accounts" because all billing accounts on the current Gmail are closed.
- Tried enabling Agent Platform API on `civil-depot-rwz46`; Google showed missing permission `serviceusage.services.enable`.
- Started Docker daemon through sudo after SAM provided local terminal credentials. The credential was not stored in the project or printed in docs.
- Slack workspace `OperaIQ` and Slack API app `OperaIQ` were created. The app is installed for the current workspace, the bot token validates, `#all-operaiq` is reachable, one wiring-check message posted, and the signing secret is stored in local `.env`.

## 5. Concrete Product Value

At 3am, a real SRE opening OperaIQ during a P1 would see the alert tied to remembered incidents, the affected service dependency map, and the next remediation step with its risk level before anyone starts searching old threads. A traditional alert dashboard shows the symptom and timestamp; OperaIQ is meant to show the closest prior fixes, which owners are affected, what action is about to run, and a post-mortem record that becomes searchable for the next incident.

## 6. Sentinel Port Checkpoint

Sentinel is now implemented and live-verified as a Splunk-native port in the same monorepo, without deleting or replacing the OperaIQ MongoDB/Google path.

Changed components:

- `packages/splunk-brain`: typed Splunk REST, KV Store, SPL search, HEC, and keyword similarity.
- `packages/splunk-mcp`: custom REST adapter because `@splunk/splunk-mcp` is not currently published on npm.
- `packages/agent/src/sentinel-runner.ts`: Sentinel agent loop with the new `INVESTIGATE` step.
- `POST /webhooks/splunk-alert`: Splunk Alert Action webhook that writes a Sentinel incident to KV Store and invokes the agent directly.
- `scripts/splunk-*` and `scripts/sentinel-*`: setup, seed, verify, tool, smoke, and webhook e2e checks.

Verified after implementation:

```text
pnpm typecheck
pnpm build
OPERAIQ_AI_PROVIDER=offline pnpm seed:verify
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm agent:smoke-test
pnpm splunk:setup-check
pnpm splunk:seed
pnpm splunk:verify
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:test-tools
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:smoke-test
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 SENTINEL_MODE=true AGENT_NAME=Sentinel NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm sentinel:e2e
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_LOCAL_PUBSUB_DIRECT=true OPERAIQ_REMEDIATION_WAIT_MS=0 NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm verify:e2e
```

Live Sentinel proof:

```text
PASSED splunk:setup-check - REST, KV Store, and HEC are reachable
PASSED splunk:seed - inserted 20 incidents, 5 services, 5 service runtime configs, 8 runbooks, 5 patterns, and 5 HEC post-mortem events
PASSED splunk:verify - seeded KV Store documents and SPL post-mortem search passed
PASSED sentinel:test-tools - all 6 Sentinel tools returned valid non-empty results
PASSED sentinel:smoke-test - status=resolved, tools=search_similar_incidents, query_splunk_logs, get_service_dependency_graph, get_runbook, execute_remediation, write_postmortem
PASSED sentinel:e2e - incident=1e353a3573b5e5a4f2f19254, postmortemId=afb40a7cb8c4a12f1443cdbc, indexedPostmortems=12
```

See `SPLUNK_SETUP.md` and `SENTINEL_VERIFICATION.md` for the exact setup and proof commands. Current known Sentinel gaps: Splunk Hosted Models are capability-gated and fall back locally, SPL keyword similarity is lower quality than Atlas Vector Search, and the official Splunk MCP npm package was unavailable so the repo uses a custom REST adapter.

Hosted Models follow-up, 2026-05-26: official Splunk docs route Hosted Models through AI Toolkit 5.7.x and the `ai` SPL command. AI Toolkit 5.7.4 and PSC 4.3.2 were downloaded through the logged-in Splunkbase browser session and installed into `sentinel-splunk`; `pnpm splunk:setup-check` passes and `pnpm splunk:hosted-models-check` proves AI Toolkit, PSC, and `ai` are present. `probeHostedModels()` now performs the runtime capability check. Local Enterprise Developer License returns false and uses Gemini fallback; Splunk Cloud Platform can use Hosted Models automatically when the probe succeeds.

## Final Status

The local zero-dollar verification path is working and does not require card billing. Slack and the container-size target are handled. Sentinel now passes live local Splunk setup, seed, verify, tool, smoke, and webhook e2e checks, while OperaIQ still passes local `verify:e2e` from the same repo. Production OperaIQ is still not complete: remaining blockers are active Google Cloud billing for Vertex/Cloud Run and a public HTTPS API URL for Pub/Sub push. The local modes are explicit and reversible; normal architecture remains the default.

# Sentinel Verification

Sentinel is implemented as a Splunk-native port that runs alongside OperaIQ. This file tracks only the four changed components.

## Current Local State

Local Splunk Enterprise was validated in Docker as `sentinel-splunk` on:

- management API: `https://localhost:8089`
- HEC: `http://localhost:8088`
- app: `sentinel`
- index: `sentinel`

The local `.env` contains Splunk credentials and the HEC token. Values are intentionally not documented here.

Hosted Models re-probe on 2026-05-25 first found Docker inactive, then continued after Docker was restarted and Splunkbase login was completed:

```text
docker version --format 'client={{.Client.Version}} server={{.Server.Version}}'
client=27.3.1 server=
Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?

curl https://localhost:8089/services/server/info?output_mode=json
curl: (7) Failed to connect to localhost port 8089: Connection refused
```

After Splunkbase login:

- Downloaded AI Toolkit 5.7.4 to `vendor/splunk/splunk-ai-toolkit-5.7.4.tgz`.
- Downloaded Python for Scientific Computing 4.3.2 to `vendor/splunk/python-for-scientific-computing-linux-4.3.2.tgz`.
- Installed both into `sentinel-splunk`.
- Added the `mltk_admin` role to local `admin` so the AI Toolkit `ai` command can execute.
- Re-disabled HEC SSL and verified HEC again.

Validated on 2026-05-25:

```text
pnpm typecheck
pnpm splunk:setup-check
pnpm splunk:verify
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:test-tools
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:smoke-test
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 SENTINEL_MODE=true AGENT_NAME=Sentinel NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm sentinel:e2e
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_LOCAL_PUBSUB_DIRECT=true OPERAIQ_REMEDIATION_WAIT_MS=0 NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm verify:e2e
```

## Re-run Protocol

After starting Splunk and the API, run:

```bash
pnpm splunk:setup-check
pnpm splunk:seed
pnpm splunk:verify
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:test-tools
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:smoke-test
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 SENTINEL_MODE=true AGENT_NAME=Sentinel NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm sentinel:e2e
```

`sentinel:e2e` expects the API server to be reachable at `NEXT_PUBLIC_API_URL` or `http://localhost:3001`.

`splunk:hosted-models-check` is intentionally separate from `splunk:setup-check`. It checks the AI Toolkit app, the Python for Scientific Computing add-on, the `ai` SPL command, and Sentinel's `probeHostedModels()` runtime capability gate. Current output on local Splunk Enterprise after installing AI Toolkit and PSC:

```text
PASSED splunk-rest - management API is reachable
PASSED splunk-ai-toolkit-app - AI Toolkit app is installed
PASSED splunk-psc-add-on - Python for Scientific Computing add-on is installed
PASSED splunk-ai-command - `ai` search command is available
CHECK splunk-legacy-llm-commands - found=none
FAILED splunk-hosted-models-probe - probeHostedModels() returned false; Sentinel will use the Gemini generation fallback in this runtime
```

This is the intended multi-environment behavior: local Splunk Enterprise keeps using Gemini generation fallback, while Splunk Cloud Platform can activate Hosted Models automatically when the probe succeeds.

## Splunk Hosted Models Re-Probe

Official Splunk docs now point to the AI Toolkit `ai` SPL command for LLM calls. The old `genai` / `llmgenerate` names from the migration prompt are not the documented path for current Splunk AI Toolkit.

Verified facts from official sources:

- AI Toolkit is a Splunkbase app, not part of a plain Splunk Enterprise install by default.
- AI Toolkit 5.7.4 requires Splunk Enterprise 9.3.x, 9.4.x, 10.x, 10.1.x, or 10.2.x, plus PSC 4.3.2.
- The `ai` SPL command was introduced in AI Toolkit 5.6.0 and requires `apply_ai_commander_command` to execute.
- Splunk Hosted Models appear as a Splunk Cloud Platform provider option in AI Toolkit 5.7.0+.
- Available Hosted Models listed by Splunk docs are OpenAI GPT-OSS 120B, OpenAI GPT-OSS 20B, and Llama-3.1-FoundationAI-SecurityLLM-base-1.1-8B.

Source references:

- AI Toolkit install requirements: `https://help.splunk.com/en/splunk-cloud-platform/apply-machine-learning/use-ai-toolkit/5.7.4/install-and-upgrade-the-ai-toolkit/install-the-ai-toolkit`
- `ai` command reference: `https://help.splunk.com/en/splunk-cloud-platform/apply-machine-learning/use-ai-toolkit/5.7.4/ai-toolkit-commands-macros-and-visualizations/about-the-ai-command`
- Hosted Models provider note: `https://help.splunk.com/en/splunk-cloud-platform/apply-machine-learning/use-ai-toolkit/5.7.4/ai-toolkit-commands-macros-and-visualizations/connections-tab-in-the-ai-toolkit`
- Splunkbase AI Toolkit listing: `https://splunkbase.splunk.com/app/2890/`

Local attempt results on 2026-05-25 before login:

```text
AI Toolkit download:
https://splunkbase.splunk.com/app/2890/release/5.7.4/download
http_code=401 content_type=text/html; charset=utf-8

PSC Linux 64-bit download:
https://splunkbase.splunk.com/app/2882/release/4.3.2/download
http_code=401 content_type=text/html; charset=utf-8
```

OpenClaw browser reached the Splunk AI Toolkit page and confirmed it shows `Log in to Download`, latest version `5.7.4`, release date `May 20, 2026`, and platform compatibility for Splunk Enterprise `9.3`, `9.4`, and `10.x`.

Current blocker, stated precisely: Hosted Models are not blocked by missing AI Toolkit anymore. AI Toolkit 5.7.4 and PSC 4.3.2 are installed, and the `ai` command is available. The blocker is the runtime edition boundary: the Hosted Models provider is a Splunk Cloud Platform capability. Sentinel now probes that capability at startup and uses Gemini fallback when the probe returns false.

## Shipped vs Imagined

| Component | Shipped | Imagined / blocked |
| --- | --- | --- |
| Splunk KV Store brain | `@operaiq/splunk-brain` implements typed REST client, KV collection create/query/insert/update/delete, and Sentinel incident writes. `pnpm splunk:setup-check` passes REST/KV/HEC, and `pnpm splunk:verify` now validates seeded KV keys even after smoke/e2e tests add runtime incidents. | Production Splunk Cloud/Enterprise deployment still needs a real hosted target and certificate policy. |
| SPL-based similarity search | `findSimilarIncidents()` searches `index=sentinel sourcetype=sentinel:postmortem` and computes keyword-overlap similarity; fallback ranks resolved KV incidents by keyword overlap. | This is lower quality than MongoDB Atlas Vector Search and should be stated in submissions. |
| Live log query tool | `query_splunk_logs` runs targeted SPL and streams an `INVESTIGATE` step between REMEMBER and MAP in `runSentinelAgent()`. `sentinel:test-tools` returned 5 indexed post-mortem rows, `sentinel:smoke-test` found 4 recent notification-service events, and `sentinel:e2e` found 6 recent events. | Splunk Hosted Models are capability-gated. Local Enterprise falls back to Gemini; Splunk Cloud Platform can activate Hosted Models without a code change when the probe succeeds. |
| Splunk Alert Action trigger | `POST /webhooks/splunk-alert` validates Splunk alert payloads, creates a Sentinel incident in KV Store, and invokes the Sentinel agent directly in the background. `sentinel:e2e` passed through the webhook and resolved incident `1e353a3573b5e5a4f2f19254`. | Browser-created saved-search alert click-through is not separately proven; the webhook payload path is proven by script. |

## Required Answers

1. Live SPL query:
   - Query: `search index=sentinel sourcetype=sentinel:postmortem | head 5`
   - Result count: `5`
   - Raw JSON sample:

```json
{
  "query": "search index=sentinel sourcetype=sentinel:postmortem | head 5",
  "resultCount": 5,
  "first": {
    "_time": "2026-05-25T07:55:58.809+00:00",
    "index": "sentinel",
    "sourcetype": "sentinel:postmortem",
    "event": {
      "type": "postmortem",
      "incidentId": "1480e3011b278a91ed1245bb",
      "title": "Splunk alert: sentinel_e2e_notification_s3_access_denied",
      "severity": "P3",
      "generatedBy": "sentinel"
    }
  }
}
```

2. Dual write:
   - Search after `sentinel:e2e`: `search index=sentinel sourcetype=sentinel:postmortem | stats count`
   - Result count: `12`
   - One returned indexed field: `incidentId=1e353a3573b5e5a4f2f19254`

3. OperaIQ + Sentinel side by side:
   - OperaIQ local e2e passed from the same repo: `PASSED verify:e2e - End-to-end flow: PASSED`
   - Sentinel local e2e passed from the same repo: `PASSED sentinel:e2e - incident=1e353a3573b5e5a4f2f19254, postmortemId=afb40a7cb8c4a12f1443cdbc, indexedPostmortems=12`
   - Shared dependency to watch: `execute_remediation` is shared and switches data source through `SENTINEL_MODE` / `AGENT_NAME=Sentinel`; Cloud Run dispatch remains shared.

4. One thing Sentinel does better:
   - Sentinel can run a live SPL investigation against recent operational events before choosing a runbook, so the agent is checking current incident evidence instead of only historical memory.

## Known Gaps

- Official `@splunk/splunk-mcp` was not available on npm, so Sentinel uses a custom REST adapter in `packages/splunk-mcp`.
- Splunk Hosted Models: probeHostedModels() returns false on local Enterprise Developer License because the | ai SPL command and SCS token endpoint are Splunk Cloud Platform features. The capability check is in place. All LLM calls route to Gemini on local deployments and will route to Splunk Hosted Models automatically on Splunk Cloud Platform without code changes.
- SPL keyword-overlap similarity is less precise than MongoDB Atlas Vector Search.
- The Docker Splunk image defaulted HEC to HTTPS. Local setup was changed to `enableSSL=0` so it matches Sentinel's documented `http://localhost:8088` HEC path.
- Pub/Sub is not used as the Sentinel trigger. It remains part of OperaIQ and existing SSE infrastructure; Sentinel uses the Splunk Alert Action webhook for trigger.

## Demo Scenario Verification

Validated on 2026-05-27:

```text
pnpm typecheck
pnpm build
pnpm splunk:setup-check
OPERAIQ_AI_PROVIDER=offline OPERAIQ_GENERATION_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_LOCAL_PUBSUB_DIRECT=true OPERAIQ_REMEDIATION_WAIT_MS=0 SENTINEL_MODE=true AGENT_NAME=Sentinel NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm sentinel:demo
```

Passing demo run:

```text
✓ Demo logs sent to Splunk
 index=prod | total events: 120
 ECONNRESET count: 44
✓ Demo Sentinel KV Store seeded
 incidents: 3 Redis/payment historical matches
 runbook: demo-redis-connection-pool
→ Incident created: 7bec7b7290fb5547536b401a [open]
→ Agent started [in_progress]
→ Tool called: search_similar_incidents
→ Tool called: query_splunk_logs
→ Tool called: get_service_dependency_graph
→ Tool called: execute_remediation
→ Tool called: write_postmortem
→ Incident resolved: 7bec7b7290fb5547536b401a [resolved] in 3s
→ Postmortem written: 83e6d9e593bd1bdde8aea9a1
```

Manual SPL verification:

```text
index=prod sourcetype=app service=payment | stats count by error_type
ECONNRESET=44
UPSTREAM_TIMEOUT=6

index=sentinel sourcetype=sentinel:postmortem | head 1
incidentId=7bec7b7290fb5547536b401a
```

UI proof artifacts:

```text
artifacts/sentinel-ui/detail-1280-active.png
artifacts/sentinel-ui/feed-1280-active.png
artifacts/sentinel-ui/detail-1280-resolved.png
artifacts/sentinel-ui/detail-mobile.png
artifacts/sentinel-ui/brain-1280.png
artifacts/sentinel-ui/services-1280.png
artifacts/sentinel-ui/proof.json
```

The browser proof used the existing OpenClaw Chrome/CDP profile. The OpenClaw browser tool blocked direct localhost navigation, so screenshots were captured through the same running profile's CDP endpoint rather than launching a second browser.

## Autonomous Detection Verification

Validated on 2026-05-27. This run did not call `pnpm sentinel:demo`, `pnpm sentinel:demo:trigger`, or any direct webhook trigger.

```text
pnpm sentinel:demo:setup
OPERAIQ_AI_PROVIDER=offline OPERAIQ_GENERATION_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_LOCAL_PUBSUB_DIRECT=true OPERAIQ_REMEDIATION_WAIT_MS=0 SENTINEL_MODE=true AGENT_NAME=Sentinel PORT=3001 pnpm --filter @operaiq/api start
pnpm sentinel:demo:logs
```

Saved search proof:

```text
name=sentinel_auto_detect_payment_errors
is_scheduled=true
cron_schedule=*/1 * * * *
actions=webhook
action.webhook.param.url=http://172.17.0.1:3001/webhooks/splunk-alert
```

Docker webhook reachability:

```text
docker exec sentinel-splunk curl -s http://172.17.0.1:3001/health
{"status":"ok","brainSize":37}
```

Autonomous run result:

```text
✓ Demo logs sent to Splunk
 index=prod | total events: 120
 ECONNRESET count: 44
 Autonomous: saved search fires if pnpm sentinel:demo:setup has run
 Manual fast-path: pnpm sentinel:demo
→ Autonomous incident observed: 9590e2e74c05bf6c314e07cf [resolved]
→ ASSESS: Sentinel parsed P1 alert for payment-service with 6 symptoms.
→ REMEMBER: Searched Splunk incident memory and found 3 similar matches. Best match: Splunk alert: sentinel_auto_detect_payment_errors (100% match).
→ INVESTIGATE: [INVESTIGATE] index=prod sourcetype=app service=payment | stats count by error_type -> ECONNRESET: 44 events in last 15 minutes.
→ MAP: payment-service maps to postgres-main, redis-cache; redis-cache is the likely root for this alert.
→ RETRIEVE: Selected runbook "Redis connection pool reset for payment checkout" with 3 steps.
→ ACT: Executing rotate_connection_pool on redis-cache with low risk.
→ ACT: rotate_connection_pool on redis-cache completed in 1s with success=true.
→ ACT: Assessment after rotate_connection_pool: proceeding based on successful tool result.
→ CLOSE: Wrote Sentinel post-mortem 9f0c5f640c6ef0c948e86f3f to Splunk KV Store and HEC.
PASSED autonomous detection — incident 9590e2e74c05bf6c314e07cf fired and resolved without trigger
postmortem=9f0c5f640c6ef0c948e86f3f
events=ASSESS,REMEMBER,INVESTIGATE,MAP,RETRIEVE,ACT,ACT,ACT,CLOSE
```

API log proof showed the Splunk default webhook payload matching the schema:

```json
{
  "result": { "error_count": "44" },
  "results_link": "http://94130cbbd40a:8000/app/search/search?...",
  "search_name": "sentinel_auto_detect_payment_errors",
  "owner": "admin",
  "app": "sentinel"
}
```

Browser proof artifacts for the autonomous incident:

```text
artifacts/sentinel-ui/autonomous-feed-1280.png
artifacts/sentinel-ui/autonomous-detail-1280.png
```

For local Docker, `host.docker.internal` did not resolve from `sentinel-splunk`, so the saved search uses the Docker bridge fallback `172.17.0.1`. After verification, the demo `prod` logs were cleared to stop the scheduled search from creating a new demo incident every minute; the saved search remains configured.

## Strict Human-Flow Verification

Validated on 2026-05-27. This run intentionally avoided `pnpm sentinel:*` shortcuts and used a fresh human-style org/project.

Acceptance standard:

```text
[Your app] -> logs to Splunk -> [Splunk watches for patterns] -> fires webhook -> [Sentinel acts]
```

Proof artifact:

```text
artifacts/human-flow/splunk-autonomous-flow-20260527182942.json
```

Result:

```text
orgId=470d1d5832c59b4e8b1f7389
projectId=project_470d1d58_20260527182942
savedSearch=sentinel_demo_human_flow_470d1d58_econnreset
incident=0614aaca6f82a6ba4392730f
postmortem=e5991eab57d99cb35b7256f5
logsSentToSplunk=86
indexedECONNRESET=34
schedulerFiredCount=1
finalStatus=resolved
postmortemIndexedCount=1
acceptance=all true
```

The first strict run caught a real parser bug: Splunk scheduled alerts can send result fields such as `host` as arrays, while the API schema only accepted strings. The fix accepts string, number, and array result values and normalizes them before incident creation.

Production caveat from this proof: the local verification stack records `rotate_connection_pool` instead of dispatching to external infrastructure. That is acceptable for orchestration proof and unacceptable for production closure. Production mode now blocks `OPERAIQ_LOCAL_VERIFY=true`, `DEMO_REMEDIATION_WAIT_MS`, and offline reasoning providers, and the UI shows the runtime gate.

Production remediation path after hardening:

- Google Cloud deployment uses `OPERAIQ_REMEDIATION_BACKEND=cloud-run` and dispatches the existing `sentinel-remediate-*` jobs.
- Railway/Render/Fly deployment uses `OPERAIQ_REMEDIATION_BACKEND=admin-endpoint` and calls `POST <adminBaseUrl>/admin/remediation` with `Authorization: Bearer <AGENT_TOOL_SECRET>`.
- Missing `adminBaseUrl`, missing secrets, or a failed admin endpoint is a failed remediation; Sentinel does not mark the action successful.
- Railway auth was attempted through CLI browserless pairing on 2026-05-27. The local OpenClaw browser was headless and timed out on the Railway login page, and the pairing expired before OAuth could complete. Deployment is blocked on completing Railway login or choosing another account-backed host.

## Demo Video Clips

Clip 0 - Autonomous Watcher

Timebox: `0:00-0:18`

Show terminal:

```bash
pnpm sentinel:demo:logs
```

The command completes and exits. Leave the screen idle with no trigger command running. After 30-60 seconds, switch to the browser feed and show the incident appearing with no human action.

Caption: `No command. No trigger. Sentinel watches and acts.`

Clip 1 stays the manual judge-reproduction fast path: run `pnpm sentinel:demo:trigger` and show `→ Incident created: <id> [open]`.

## Demo UI Streaming Addendum

Does the reasoning panel stream in real time or does it hydrate from stored steps on page load?

During an active run, the panel streams in real time over `EventSource` from `/incidents/:id/stream` and appends each agent step as the API dispatches it. When loading an already resolved incident, the page hydrates from `incident.agentEvents` stored on the Sentinel incident in Splunk KV Store.

## Multi-Tenancy Verification

Validated on 2026-05-27 against a clean API process on `PORT=3102` with `JWT_SECRET=local-jwt-secret-for-verification`.

Commands/results:

```text
pnpm typecheck
PASSED

pnpm build
PASSED

pnpm --filter @operaiq/agent build
PASSED

pnpm --filter @operaiq/api build
PASSED

pnpm splunk:setup-check
PASSED splunk-rest, splunk-kvstore, splunk-hec

NEXT_PUBLIC_API_URL=http://localhost:3102 ... pnpm sentinel:demo
→ Incident resolved: ac3bba40c5c7a8b516d53769 [resolved] in 10s
REMEMBER: Redis connection pool exhaustion - payment-service (95%), payment-service latency spike - Redis timeout (75%), Redis ECONNRESET cascade - 3 services affected (75%)

NEXT_PUBLIC_API_URL=http://localhost:3102 ... pnpm sentinel:e2e
PASSED sentinel:e2e - incident=0637186f38b1d2c1978d4d22, postmortemId=7ff36a0a86c4bf88633b34a5, indexedPostmortems=6

NEXT_PUBLIC_API_URL=http://localhost:3102 ... pnpm verify:e2e
PASSED verify:e2e - End-to-end flow: PASSED
```

Org isolation spot check:

```text
Created org-beta through POST /auth/signup.
GET /incidents as org-beta -> {"total":0,"count":0}
GET /incidents/688285274ff54549e1c22927 as org-beta -> 403 {"error":"Forbidden"}
GET /incidents as demo-org -> total=4, including Splunk alert: sentinel_demo_payment_redis_spike and the 3 seeded Redis/payment history rows.
```

If two engineers from different companies both deploy Sentinel tomorrow, can their incident histories ever mix?

No. Sentinel API reads and writes require a JWT-derived `orgId`, every org-scoped KV Store document is stamped with that `orgId`, every org-scoped query injects the same `orgId`, and Splunk webhooks must authenticate with that org's hashed webhook secret before incident creation.

## Execution Upgrades Verification

Validated on 2026-05-27 after inspecting the dirty tree and resuming from the interrupted verification point.

Final suite results:

```text
pnpm typecheck
PASSED

pnpm build
PASSED

pnpm splunk:setup-check
PASSED splunk-rest, splunk-kvstore, splunk-hec

pnpm sentinel:e2e
PASSED sentinel:e2e - incident=33a0f84d54cebe9e7abd85e3, postmortemId=4062747b2648dba060bba14b, indexedPostmortems=12

OPERAIQ_LOCAL_PUBSUB_DIRECT=true NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm verify:e2e
PASSED verify:e2e - End-to-end flow: PASSED

pnpm sentinel:test-feedback-loop
PASSED feedback-loop - incident 1d6e2797bc664f70713bd834 resolved after second remediation step

pnpm sentinel:demo:escalate
PASSED escalation - incident 065d0d3dfb42888a505f1678 escalated correctly

pnpm sentinel:demo:learning-loop
PASSED
Incident 1 (novel): resolved in 21.6s, best match: 0%
Incident 2 (recognised): resolved in 7.1s, best match: 95%

pnpm sentinel:test-dlq
PASSED dlq - incident 7e26ff331379f61d13dc34db recovered after forced crash

pnpm sentinel:demo
→ Incident resolved: 1f865cb039a17382d62750c5 [resolved] in 12.6s
→ Postmortem written: 13285d6840170a7691c9e296
```

Timing display fixed after this run: learning-loop and `sentinel:demo` now print decimal seconds so the shown output matches the millisecond assertion instead of rounding different durations into the same whole-second value.

Audit proof:

```text
GET /audit/068182a58632e0623d87188d
status=200 total=16 firstPhase=ASSESS lastPhase=CLOSE

index=sentinel sourcetype=sentinel:audit | stats count
count=498
```

Learning-loop audit counts:

```text
incident=068182a58632e0623d87188d auditEntries=16 bestSimilarityScore=0.125
incident=bd01ff832692c2dd5832a196 auditEntries=16 bestSimilarityScore=0.95
```

Verify results from the first learning-loop incident:

```json
[
  {
    "timestamp": "2026-05-27T13:51:49.645Z",
    "errorCount": 1,
    "passed": true
  }
]
```

Correlation report sample from resolved incident `02628b4b621569ef415423f0`:

```text
rootCauseCandidate=redis-cache
payment-service -> anomalous, ECONNRESET, errorCount=76
postgres-main -> clean, errorCount=0
redis-cache -> anomalous, connection pool exhausted, errorCount=23
```

Severity upgrade sample from the same incident:

```text
severity=P2
severityUpgradedFrom=P3
severityUpgradeReason=Blast radius: 3 services - upgraded from P3 to P2
```

Escalation Slack body captured from the audit log output:

```text
🔴 Sentinel escalating — mystery-service P2
Similarity confidence: 17% (below threshold)
Tried: notify_team on mystery-service, restart_pod on mystery-service
None resolved. Full investigation: http://localhost:3000/incidents/065d0d3dfb42888a505f1678
@oncall please investigate.
```

Native Splunk dashboard proof:

```text
docker cp apps/splunk-app/sentinel/default sentinel-splunk:/opt/splunk/etc/apps/sentinel/
docker exec -u root sentinel-splunk chown -R splunk:splunk /opt/splunk/etc/apps/sentinel/default
docker exec -u splunk sentinel-splunk /opt/splunk/bin/splunk restart --accept-license --answer-yes --no-prompt

curl -k -u admin:<redacted> https://localhost:8089/servicesNS/admin/sentinel/data/ui/views/sentinel_overview
http_code=200

Screenshot: artifacts/sentinel-ui/splunk-native-dashboard.png
PNG: 1440 x 1100, 58,984 bytes
Panels found: Active incidents, Brain size, Resolution timeline, Severity distribution, Recent agent decisions, Service health
Panel errors: none
```

The dashboard copy initially exposed a container-user mismatch: the default `docker exec` user is `ansible`, which cannot restart Splunk. The deployed proof uses the Splunk-owned app files and restarts Splunk as `splunk`.

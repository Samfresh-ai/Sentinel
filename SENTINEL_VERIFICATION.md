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

`splunk:hosted-models-check` is intentionally separate from `splunk:setup-check`. It checks the AI Toolkit app, the Python for Scientific Computing add-on, the `ai` SPL command, the Splunk Cloud Services token endpoint, and then attempts a real Hosted Models search. Current output after installing AI Toolkit and PSC:

```text
PASSED splunk-rest - management API is reachable
PASSED splunk-ai-toolkit-app - AI Toolkit app is installed
PASSED splunk-psc-add-on - Python for Scientific Computing add-on is installed
PASSED splunk-ai-command - `ai` search command is available
CHECK splunk-legacy-llm-commands - found=none
FAILED splunk-scs-token-endpoint - status=404 message=Not Found
FAILED splunk-hosted-models-search - Error in 'ai' command: No configuration found for provider: "Splunk Hosted Models" and model: "OpenAI GPT-OSS 20B" | Error in 'ai' command: No configuration found for provider: "Splunk Hosted Models" and model: "gpt-oss-20b" | Error in 'ai' command: No default LLM configuration found.
```

This is the real Hosted Models blocker for the local environment: the app is installed, but local Splunk Enterprise does not expose the SCS token endpoint AI Toolkit calls for Hosted Models.

## Splunk Hosted Models Re-Probe

Official Splunk docs now point to the AI Toolkit `ai` SPL command for LLM calls. The old `genai` / `llmgenerate` names from the migration prompt are not the documented path for current Splunk AI Toolkit.

Verified facts from official sources:

- AI Toolkit is a Splunkbase app, not part of a plain Splunk Enterprise install by default.
- AI Toolkit 5.7.4 requires Splunk Enterprise 9.3.x, 9.4.x, 10.x, 10.1.x, or 10.2.x, plus PSC 4.3.2.
- The `ai` SPL command was introduced in AI Toolkit 5.6.0 and requires `apply_ai_commander_command` to execute.
- Splunk Hosted Models appear as a provider option in AI Toolkit 5.7.0+ and require `list_tokens_scs` capability to see.
- Available Hosted Models listed by Splunk docs are OpenAI GPT-OSS 120B, OpenAI GPT-OSS 20B, and Llama-3.1-FoundationAI-SecurityLLM-base-1.1-8B.

Source references:

- AI Toolkit install requirements: `https://help.splunk.com/en/splunk-cloud-platform/apply-machine-learning/use-ai-toolkit/5.7.4/install-and-upgrade-the-ai-toolkit/install-the-ai-toolkit`
- `ai` command reference: `https://help.splunk.com/en/splunk-cloud-platform/apply-machine-learning/use-ai-toolkit/5.7.4/ai-toolkit-commands-macros-and-visualizations/about-the-ai-command`
- Hosted Models provider/capability note: `https://help.splunk.com/en/splunk-enterprise/apply-machine-learning/use-ai-toolkit/5.7.0/ai-toolkit-commands-macros-and-visualizations/connections-tab-in-the-ai-toolkit`
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

Current blocker, stated precisely: Hosted Models are not blocked by missing AI Toolkit anymore. AI Toolkit 5.7.4 and PSC 4.3.2 are installed, and the `ai` command is available. The blocker is that this local Splunk Enterprise instance returns `404 Not Found` for `/services/authorization/scs_tokens?principalId=slim&scope=tenant`, which AI Toolkit calls to obtain a Splunk Cloud Services token. Without that token, AI Toolkit cannot fetch Hosted Models into its LLM connection config, and `| ai ... provider="Splunk Hosted Models"` fails with `No configuration found for provider`.

## Shipped vs Imagined

| Component | Shipped | Imagined / blocked |
| --- | --- | --- |
| Splunk KV Store brain | `@operaiq/splunk-brain` implements typed REST client, KV collection create/query/insert/update/delete, and Sentinel incident writes. `pnpm splunk:setup-check` passes REST/KV/HEC, and `pnpm splunk:verify` now validates seeded KV keys even after smoke/e2e tests add runtime incidents. | Production Splunk Cloud/Enterprise deployment still needs a real hosted target and certificate policy. |
| SPL-based similarity search | `findSimilarIncidents()` searches `index=sentinel sourcetype=sentinel:postmortem` and computes keyword-overlap similarity; fallback ranks resolved KV incidents by keyword overlap. | This is lower quality than MongoDB Atlas Vector Search and should be stated in submissions. |
| Live log query tool | `query_splunk_logs` runs targeted SPL and streams an `INVESTIGATE` step between REMEMBER and MAP in `runSentinelAgent()`. `sentinel:test-tools` returned 5 indexed post-mortem rows, `sentinel:smoke-test` found 4 recent notification-service events, and `sentinel:e2e` found 6 recent events. | Splunk Hosted Models are not callable on the local Splunk Enterprise container. AI Toolkit + PSC + `ai` are installed, but `/services/authorization/scs_tokens` returns `404 Not Found`, so no Hosted Models config is created. |
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
- Splunk Hosted Models are not callable on the local Splunk Enterprise container. AI Toolkit 5.7.4, PSC 4.3.2, and the `ai` command are installed. The remaining blocker is Splunk Cloud Services integration: `/services/authorization/scs_tokens?principalId=slim&scope=tenant` returns `404 Not Found`, and the `ai` command cannot find a `Splunk Hosted Models` model configuration.
- SPL keyword-overlap similarity is less precise than MongoDB Atlas Vector Search.
- The Docker Splunk image defaulted HEC to HTTPS. Local setup was changed to `enableSSL=0` so it matches Sentinel's documented `http://localhost:8088` HEC path.
- Pub/Sub is not used as the Sentinel trigger. It remains part of OperaIQ and existing SSE infrastructure; Sentinel uses the Splunk Alert Action webhook for trigger.

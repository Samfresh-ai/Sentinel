# Splunk Setup for Sentinel

Sentinel expects local Splunk Enterprise 9.x with KV Store, management API, and HEC enabled.

## Required Local Shape

- Splunk management API: `https://localhost:8089`
- Splunk HEC: `http://localhost:8088`
- Splunk app: `sentinel`
- Splunk index: `sentinel`
- HEC token name: `sentinel-hec`
- HEC source type: `_json`

## Install and Start

After downloading the Splunk Enterprise 9.x Linux package from Splunk:

```bash
sudo dpkg -i splunk-*.deb
sudo /opt/splunk/bin/splunk start --accept-license --answer-yes
sudo /opt/splunk/bin/splunk enable boot-start
```

Set or reset the local admin password:

```bash
sudo /opt/splunk/bin/splunk edit user admin -password '<new-password>' -role admin -auth admin:'<current-password>'
```

Apply a Developer License after downloading it from Splunk:

```bash
sudo /opt/splunk/bin/splunk add licenses /path/to/Splunk.Developer.license -auth admin:'<password>'
sudo /opt/splunk/bin/splunk restart
```

## Docker Local Path Used for Verification

This repo was verified locally with the official Splunk Docker image:

```bash
docker pull splunk/splunk:9.4
docker run -d --name sentinel-splunk \
  -p 8000:8000 \
  -p 8088:8088 \
  -p 8089:8089 \
  -e SPLUNK_START_ARGS=--accept-license \
  -e SPLUNK_PASSWORD='<password>' \
  -e SPLUNK_HEC_TOKEN='<token>' \
  splunk/splunk:9.4
```

The image starts HEC with SSL enabled by default. Sentinel's local setup expects HEC at `http://localhost:8088`, so disable HEC SSL after the container is ready:

```bash
curl -sk -u admin:'<password>' https://localhost:8089/services/data/inputs/http/http \
  -d enableSSL=0 \
  -d output_mode=json

docker exec --user splunk sentinel-splunk /opt/splunk/bin/splunk restart
```

When using Docker, run Splunk CLI commands as the `splunk` user:

```bash
docker exec --user splunk sentinel-splunk /opt/splunk/bin/splunk create app sentinel -label Sentinel -auth admin:'<password>'
docker exec --user splunk sentinel-splunk /opt/splunk/bin/splunk add index sentinel -auth admin:'<password>'
```

## Create the Sentinel App

```bash
sudo /opt/splunk/bin/splunk create app sentinel -label Sentinel -auth admin:'<password>'
sudo /opt/splunk/bin/splunk restart
```

KV Store is enabled by default in Splunk Enterprise. Confirm it through the management API:

```bash
curl -sk -u admin:'<password>' 'https://localhost:8089/services/server/info?output_mode=json'
```

## Create the Sentinel Index

```bash
curl -sk -u admin:'<password>' https://localhost:8089/services/data/indexes \
  -d name=sentinel \
  -d datatype=event \
  -d output_mode=json
```

## Enable HEC and Create Token

```bash
curl -sk -u admin:'<password>' https://localhost:8089/services/data/inputs/http/http \
  -d disabled=0 \
  -d output_mode=json

curl -sk -u admin:'<password>' https://localhost:8089/services/data/inputs/http \
  -d name=sentinel-hec \
  -d index=sentinel \
  -d sourcetype=_json \
  -d output_mode=json
```

Copy the token value from Splunk into `.env` as `SPLUNK_HEC_TOKEN`.

## .env Values

```bash
SPLUNK_HOST=localhost
SPLUNK_MGMT_PORT=8089
SPLUNK_HEC_PORT=8088
SPLUNK_USERNAME=admin
SPLUNK_PASSWORD=<password>
SPLUNK_HEC_TOKEN=<token>
SPLUNK_APP=sentinel
SPLUNK_INDEX=sentinel
AGENT_NAME=Sentinel
SENTINEL_MODE=true
```

Do not commit `.env`.

## Verify

```bash
pnpm splunk:setup-check
pnpm splunk:hosted-models-check
pnpm splunk:seed
pnpm splunk:verify
```

## Native Sentinel Dashboard

Deploy the native Simple XML dashboard into the running Splunk container:

```bash
docker cp apps/splunk-app/sentinel/default sentinel-splunk:/opt/splunk/etc/apps/sentinel/
docker exec sentinel-splunk /opt/splunk/bin/splunk restart
```

Verify the view is registered:

```bash
curl -k -u admin:$SPLUNK_PASSWORD \
  "https://localhost:8089/servicesNS/admin/sentinel/data/ui/views/sentinel_overview" \
  -o /dev/null -w "%{http_code}"
```

Expected response: `200`.

Open the dashboard:

```text
http://localhost:8000/app/sentinel/sentinel_overview
```

## Splunk Hosted Models

Hosted Models are not available from plain Splunk Enterprise alone. Splunk documents the LLM path through the AI Toolkit `ai` SPL command.

Required before claiming the Hosted Models prize lane:

1. Install AI Toolkit 5.7.x from Splunkbase.
2. Install the matching Python for Scientific Computing add-on. For AI Toolkit 5.7.4, Splunk documents PSC 4.3.2.
3. Restart Splunk.
4. Confirm the `ai` SPL command exists.
5. Confirm the current user can see the Splunk Hosted Models provider in AI Toolkit Connections on Splunk Cloud Platform.
6. Run:

```bash
pnpm splunk:hosted-models-check
```

Current local behavior: AI Toolkit 5.7.4 and PSC 4.3.2 are installed, and the `ai` command is available. `probeHostedModels()` returns false on local Enterprise Developer License, so Sentinel routes generated reasoning through Gemini fallback. This is the intended capability check for local Enterprise versus Splunk Cloud Platform.

Latest blocker proof:

```text
PASSED splunk-rest - management API is reachable
PASSED splunk-ai-toolkit-app - AI Toolkit app is installed
PASSED splunk-psc-add-on - Python for Scientific Computing add-on is installed
PASSED splunk-ai-command - `ai` search command is available
CHECK splunk-legacy-llm-commands - found=none
FAILED splunk-hosted-models-probe - probeHostedModels() returned false; Sentinel will use the Gemini generation fallback in this runtime
```

Then run Sentinel agent checks:

```bash
SENTINEL_AI_PROVIDER=offline SENTINEL_LOCAL_VERIFY=true SENTINEL_REMEDIATION_WAIT_MS=0 pnpm sentinel:test-tools
SENTINEL_AI_PROVIDER=offline SENTINEL_LOCAL_VERIFY=true SENTINEL_REMEDIATION_WAIT_MS=0 pnpm sentinel:smoke-test
```

For API webhook e2e, start the API first:

```bash
pnpm build
SENTINEL_AI_PROVIDER=offline SENTINEL_LOCAL_VERIFY=true SENTINEL_REMEDIATION_WAIT_MS=0 SENTINEL_MODE=true AGENT_NAME=Sentinel PORT=3001 node apps/api/dist/server.js
SENTINEL_AI_PROVIDER=offline SENTINEL_LOCAL_VERIFY=true SENTINEL_REMEDIATION_WAIT_MS=0 SENTINEL_MODE=true AGENT_NAME=Sentinel NEXT_PUBLIC_API_URL=http://localhost:3001 pnpm sentinel:e2e
```

If `.env` sets `SENTINEL_GENERATION_PROVIDER=nvidia` or another OpenAI-compatible free model, that provider takes precedence over `SENTINEL_AI_PROVIDER=offline`. This is allowed for local free-model validation; generated post-mortem arrays are normalized before writing to KV Store and HEC.

## Splunk Alert Action

Create a saved search alert that posts to the org-specific API URL generated by the Sentinel setup screen:

```conf
[sentinel_alert]
search = index=prod sourcetype=app service=payment error_type=ECONNRESET | stats count as error_count | where error_count >= 30 | eval service="payment-service", severity="P1"
alert.track = 1
alert.suppress = 0
alert.severity = 3
action.webhook = 1
action.webhook.param.url = https://<sentinel-api-url>/webhooks/splunk-alert?orgId=<org-id>&secret=<shown-once-secret>
```

The route requires the org id and secret. Do not use a generic unauthenticated webhook URL.

## Human-Flow Acceptance Test

The proof path should be a real scheduled Splunk alert, not a direct webhook shortcut:

```text
your app -> Splunk HEC -> Splunk saved search -> webhook -> Sentinel ACT/VERIFY/CLOSE
```

Run the direct proof script without a `pnpm sentinel:*` shortcut:

```bash
./node_modules/.bin/tsx --conditions=development scripts/sentinel-human-flow.ts
```

That script creates a fresh Sentinel org/project, writes app logs to Splunk HEC, configures a scheduled saved search, waits for the webhook-fired incident, and verifies Sentinel reached ACT, VERIFY, CLOSE, and post-mortem write.

For Docker-local Splunk calling a local API, first confirm the container can reach the host API. For the current live Render API, the saved search can call the public API URL directly.

```bash
docker exec sentinel-splunk curl -s http://172.17.0.1:3001/health
```

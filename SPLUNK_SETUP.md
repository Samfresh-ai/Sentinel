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
pnpm splunk:seed
pnpm splunk:verify
```

Then run Sentinel agent checks:

```bash
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:test-tools
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:smoke-test
```

For API webhook e2e, start the API first:

```bash
pnpm --filter @operaiq/api dev
OPERAIQ_AI_PROVIDER=offline OPERAIQ_LOCAL_VERIFY=true OPERAIQ_REMEDIATION_WAIT_MS=0 pnpm sentinel:e2e
```

## Splunk Alert Action

Create a saved search alert that posts to the API:

```conf
[sentinel_alert]
search = index=sentinel OR index=_internal | stats count by source | where count > 0
alert.track = 1
alert.suppress = 0
alert.severity = 3
action.webhook = 1
action.webhook.param.url = http://localhost:3001/webhooks/splunk-alert
```

The webhook route also accepts direct test payloads from `pnpm sentinel:e2e`.

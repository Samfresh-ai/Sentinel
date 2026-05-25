import { ServicesClient } from "@google-cloud/run";
import { WebClient } from "@slack/web-api";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createLogger, loadRootEnv, remediationActionSchema } from "@operaiq/shared";

loadRootEnv();
const logger = createLogger("operaiq-remediation-job");

const parametersSchema = z.record(z.union([z.string(), z.number()]));

const serviceConfigSchema = z.object({
  name: z.string().min(1),
  owners: z.array(z.string()),
  incidentChannel: z.string().nullable(),
  adminBaseUrl: z.string().nullable(),
  cloudRunServiceName: z.string().nullable()
});

type ServiceExecutionConfig = z.infer<typeof serviceConfigSchema>;
type RemediationParameters = z.infer<typeof parametersSchema>;

function parseRequiredJson<T>(name: string, schema: z.ZodType<T>): T {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(`${name} is required`);
  }
  const parsed: unknown = JSON.parse(raw);
  return schema.parse(parsed);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parameterString(parameters: RemediationParameters, key: string): string | undefined {
  const value = parameters[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parameterNumber(parameters: RemediationParameters, key: string): number | undefined {
  const value = parameters[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cloudRunServiceResource(service: string): string {
  return `projects/${requiredEnv("GOOGLE_CLOUD_PROJECT_ID")}/locations/${requiredEnv("GOOGLE_CLOUD_REGION")}/services/${service}`;
}

async function callAdminEndpoint(config: ServiceExecutionConfig, path: string): Promise<string> {
  if (!config.adminBaseUrl) {
    throw new Error(`Service ${config.name} does not define adminBaseUrl`);
  }
  const url = new URL(path, config.adminBaseUrl);
  const response = await fetch(url, { method: "POST" });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${url.toString()} returned ${response.status}: ${body}`);
  }
  return body.length > 0 ? body : `${url.toString()} returned ${response.status}`;
}

async function updateCloudRunService(
  action: "scale_service" | "restart_pod",
  config: ServiceExecutionConfig,
  parameters: RemediationParameters
): Promise<string> {
  if (!config.cloudRunServiceName) {
    throw new Error(`Service ${config.name} does not define cloudRunServiceName`);
  }
  const client = new ServicesClient();
  const name = cloudRunServiceResource(config.cloudRunServiceName);
  const [service] = await client.getService({ name });
  const template = service.template ?? {};
  const annotations = {
    ...(template.annotations ?? {}),
    "operaiq.lastAction": action,
    "operaiq.lastActionAt": new Date().toISOString()
  };
  const minInstanceCount =
    action === "scale_service"
      ? parameterNumber(parameters, "instances") ?? template.scaling?.minInstanceCount ?? 1
      : template.scaling?.minInstanceCount;
  const updatedService = {
    ...service,
    template: {
      ...template,
      annotations,
      scaling: {
        ...(template.scaling ?? {}),
        ...(typeof minInstanceCount === "number" ? { minInstanceCount } : {})
      }
    }
  };
  const updateMask =
    action === "scale_service"
      ? { paths: ["template.annotations", "template.scaling.min_instance_count"] }
      : { paths: ["template.annotations"] };
  const [operation] = await client.updateService({ service: updatedService, updateMask });
  await operation.promise();
  return `${action} updated Cloud Run service ${name}`;
}

async function notifyTeam(config: ServiceExecutionConfig, parameters: RemediationParameters): Promise<string> {
  const token = requiredEnv("SLACK_BOT_TOKEN");
  const channel = config.incidentChannel ?? requiredEnv("SLACK_DEFAULT_INCIDENT_CHANNEL");
  const client = new WebClient(token);
  const severity = parameterString(parameters, "severity") ?? "P2";
  const symptoms = parameterString(parameters, "symptoms") ?? "not provided";
  const reasoning = parameterString(parameters, "reasoning") ?? "OperaIQ selected a low-risk team notification.";
  const incidentId = parameterString(parameters, "incidentId") ?? "";
  const publicAppUrl = process.env.PUBLIC_APP_URL ?? "http://localhost:3000";
  const ownerMentions = config.owners.map((owner) => `<@${owner}>`).join(" ");
  const text = [
    `*OperaIQ Incident* - ${config.name} ${severity}`,
    `*Status:* In progress`,
    `*Symptoms:* ${symptoms}`,
    `*OperaIQ reasoning:* ${reasoning}`,
    `*Next action:* Team notification executed by Cloud Run remediation job`,
    incidentId ? `*Track live:* ${publicAppUrl}/incidents/${incidentId}` : `*Track live:* ${publicAppUrl}`,
    ownerMentions.length > 0 ? `*Owners:* ${ownerMentions}` : ""
  ]
    .filter((line) => line.length > 0)
    .join("\n");
  const response = await client.chat.postMessage({ channel, text, mrkdwn: true });
  return `Slack message posted at ${response.ts ?? "unknown timestamp"}`;
}

export async function run(): Promise<void> {
  const action = remediationActionSchema.parse(requiredEnv("REMEDIATION_ACTION"));
  const config = parseRequiredJson("REMEDIATION_SERVICE_CONFIG_JSON", serviceConfigSchema);
  const parameters = parseRequiredJson("REMEDIATION_PARAMETERS_JSON", parametersSchema);

  let output: string;
  if (action === "scale_service" || action === "restart_pod") {
    output = await updateCloudRunService(action, config, parameters);
  } else if (action === "purge_cache") {
    output = await callAdminEndpoint(config, "/admin/cache/flush");
  } else if (action === "rotate_connection_pool") {
    output = await callAdminEndpoint(config, "/admin/connections/reset");
  } else {
    output = await notifyTeam(config, parameters);
  }
  logger.info({ action, targetService: config.name, output }, "Remediation job completed");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    logger.error({ error }, "Remediation job failed");
    process.exitCode = 1;
  });
}

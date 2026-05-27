import { ObjectId } from "mongodb";
import { JobsClient } from "@google-cloud/run";
import { WebClient } from "@slack/web-api";
import { splunkHecSend, splunkKvPut, splunkKvQuery } from "@operaiq/splunk-mcp";
import { remediationExecutionsCollection } from "@operaiq/brain";
import { executeRemediationInputSchema, type ExecuteRemediationResult, type RemediationAction, type RiskLevel } from "@operaiq/shared";
import { assertProductionSafeRuntime, canUseLocalVerificationEffect } from "@operaiq/shared";
import { mongoAggregate, mongoFind } from "../mcp.js";
import { getAgentEnv } from "../env.js";
import { executeRemediationSchema, type AgentToolDefinition } from "../tool-json-schemas.js";
import { asString, asStringArray, databaseName, invocationFailed, invocationFinished, invocationStarted } from "./common.js";

type ServiceExecutionConfig = {
  name: string;
  owners: string[];
  incidentChannel: string | null;
  adminBaseUrl: string | null;
  cloudRunServiceName: string | null;
};

function parameterString(parameters: Record<string, string | number>, key: string): string | undefined {
  const value = parameters[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function riskFromParameters(parameters: Record<string, string | number>): RiskLevel {
  const value = parameterString(parameters, "riskLevel");
  if (value === "medium" || value === "high") return value;
  return "low";
}

function isLocalVerifyMode(): boolean {
  return canUseLocalVerificationEffect();
}

function isSentinelMode(): boolean {
  return process.env.SENTINEL_MODE?.toLowerCase() === "true" || getAgentEnv().AGENT_NAME.toLowerCase() === "sentinel";
}

function agentName(): string {
  return isSentinelMode() ? "Sentinel" : "OperaIQ";
}

function cloudRunJobResource(action: RemediationAction): string {
  const env = getAgentEnv();
  const jobName = `${env.CLOUD_RUN_REMEDIATION_JOB_PREFIX}-${action.replaceAll("_", "-")}`;
  return `projects/${env.GOOGLE_CLOUD_PROJECT_ID}/locations/${env.GOOGLE_CLOUD_REGION}/jobs/${jobName}`;
}

function slackClient(): WebClient {
  const token = getAgentEnv().SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error("SLACK_BOT_TOKEN is required for Slack notifications");
  }
  return new WebClient(token);
}

async function serviceConfig(targetService: string, orgId?: string): Promise<ServiceExecutionConfig> {
  if (isSentinelMode() && orgId) {
    const serviceDoc = (await splunkKvQuery("services", { name: targetService }, 1, orgId))[0];
    if (!serviceDoc) {
      return {
        name: targetService,
        owners: [],
        incidentChannel: getAgentEnv().SLACK_DEFAULT_INCIDENT_CHANNEL || (isLocalVerifyMode() ? "local-verify" : null),
        adminBaseUrl: null,
        cloudRunServiceName: null
      };
    }
    const runtimeDoc = (await splunkKvQuery("service_runtime_configs", { serviceName: targetService }, 1, orgId))[0];
    return {
      name: asString(serviceDoc.name),
      owners: asStringArray(serviceDoc.owners),
      incidentChannel: asString(runtimeDoc?.incidentChannel) || getAgentEnv().SLACK_DEFAULT_INCIDENT_CHANNEL || null,
      adminBaseUrl: asString(runtimeDoc?.adminBaseUrl) || null,
      cloudRunServiceName: asString(runtimeDoc?.cloudRunServiceName) || null
    };
  }

  const serviceDocs = await mongoFind({
    database: databaseName(),
    collection: "services",
    filter: { name: targetService },
    limit: 1
  });
  const serviceDoc = serviceDocs[0];
  if (!serviceDoc) {
    throw new Error(`Service ${targetService} not found in MongoDB brain`);
  }
  const runtimeDocs = await mongoFind({
    database: databaseName(),
    collection: "service_runtime_configs",
    filter: { serviceName: targetService },
    limit: 1
  });
  const runtimeDoc = runtimeDocs[0];
  return {
    name: asString(serviceDoc.name),
    owners: asStringArray(serviceDoc.owners),
    incidentChannel: asString(runtimeDoc?.incidentChannel) || getAgentEnv().SLACK_DEFAULT_INCIDENT_CHANNEL || null,
    adminBaseUrl: asString(runtimeDoc?.adminBaseUrl) || null,
    cloudRunServiceName: asString(runtimeDoc?.cloudRunServiceName) || null
  };
}

function validateConfigForAction(action: RemediationAction, config: ServiceExecutionConfig): void {
  if ((action === "scale_service" || action === "restart_pod") && !config.cloudRunServiceName) {
    throw new Error(`service_runtime_configs.${config.name}.cloudRunServiceName is required for ${action}`);
  }
  if ((action === "purge_cache" || action === "rotate_connection_pool") && !config.adminBaseUrl) {
    throw new Error(`service_runtime_configs.${config.name}.adminBaseUrl is required for ${action}`);
  }
  if (action === "notify_team" && isLocalVerifyMode()) return;
  if (action === "notify_team" && !config.incidentChannel) {
    throw new Error(`service_runtime_configs.${config.name}.incidentChannel or SLACK_DEFAULT_INCIDENT_CHANNEL is required for ${action}`);
  }
}

async function logExecution(input: {
  action: RemediationAction;
  targetService: string;
  parameters: Record<string, string | number>;
  riskLevel: RiskLevel;
  success: boolean;
  output: string;
  requiresHumanApproval: boolean;
  executedAt: Date;
  orgId?: string;
}): Promise<void> {
  if (isSentinelMode() && input.orgId) {
    const document = {
      orgId: input.orgId,
      action: input.action,
      targetService: input.targetService,
      parameters: input.parameters,
      riskLevel: input.riskLevel,
      success: input.success,
      output: input.output,
      requiresHumanApproval: input.requiresHumanApproval,
      executedAt: input.executedAt.toISOString(),
      createdAt: new Date().toISOString()
    };
    await splunkKvPut("remediation_executions", null, document, input.orgId);
    await splunkHecSend({
      sourcetype: "sentinel:remediation",
      event: {
        type: "remediation_execution",
        ...document,
        generatedBy: "sentinel"
      }
    });
    return;
  }

  await (await remediationExecutionsCollection()).insertOne({
    _id: new ObjectId(),
    action: input.action,
    targetService: input.targetService,
    parameters: input.parameters,
    riskLevel: input.riskLevel,
    success: input.success,
    output: input.output,
    requiresHumanApproval: input.requiresHumanApproval,
    executedAt: input.executedAt,
    createdAt: new Date()
  });
}

async function postSlackMessage(config: ServiceExecutionConfig, input: {
  action: RemediationAction;
  targetService: string;
  parameters: Record<string, string | number>;
  approvalRequired: boolean;
}): Promise<string> {
  const channel = config.incidentChannel;
  if (!channel) {
    throw new Error("SLACK_DEFAULT_INCIDENT_CHANNEL or service incidentChannel is required");
  }
  const env = getAgentEnv();
  const severity = parameterString(input.parameters, "severity") ?? "P2";
  const symptoms = parameterString(input.parameters, "symptoms") ?? "not provided";
  const reasoning = parameterString(input.parameters, "reasoning") ?? `${agentName()} remediation policy selected this action from current incident context.`;
  const incidentId = parameterString(input.parameters, "incidentId") ?? "";
  const liveUrl = incidentId ? `${env.PUBLIC_APP_URL}/incidents/${incidentId}` : env.PUBLIC_APP_URL;
  const ownerMentions = config.owners.map((owner) => `<@${owner}>`).join(" ");
  const escalationMessage = input.action === "notify_team" ? parameterString(input.parameters, "escalationMessage") : undefined;
  const text = escalationMessage ?? [
    `*${agentName()} Incident* - ${input.targetService} ${severity}`,
    `*Status:* In progress`,
    `*Symptoms:* ${symptoms}`,
    `*${agentName()} reasoning:* ${reasoning}`,
    `*Next action:* ${input.action}${input.approvalRequired ? " (approval required)" : " (low risk - executing automatically)"}`,
    `*Track live:* ${liveUrl}`,
    ownerMentions.length > 0 ? `*Owners:* ${ownerMentions}` : ""
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  if (!input.approvalRequired) {
    const response = await slackClient().chat.postMessage({ channel, text, mrkdwn: true });
    return `Slack message posted at ${response.ts ?? "unknown timestamp"}`;
  }

  const response = await slackClient().chat.postMessage({
    channel,
    text,
    mrkdwn: true,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text
        }
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            value: JSON.stringify({
              action: input.action,
              targetService: input.targetService,
              parameters: input.parameters
            }),
            action_id: "operaiq_approve_remediation"
          }
        ]
      }
    ]
  });
  return `Slack approval request posted at ${response.ts ?? "unknown timestamp"}`;
}

function jobEnv(input: {
  action: RemediationAction;
  targetService: string;
  config: ServiceExecutionConfig,
  parameters: Record<string, string | number>;
}): Array<{ name: string; value: string }> {
  const env = getAgentEnv();
  return [
    { name: "REMEDIATION_ACTION", value: input.action },
    { name: "REMEDIATION_TARGET_SERVICE", value: input.targetService },
    { name: "REMEDIATION_PARAMETERS_JSON", value: JSON.stringify(input.parameters) },
    { name: "REMEDIATION_SERVICE_CONFIG_JSON", value: JSON.stringify(input.config) },
    { name: "GOOGLE_CLOUD_PROJECT_ID", value: env.GOOGLE_CLOUD_PROJECT_ID },
    { name: "GOOGLE_CLOUD_REGION", value: env.GOOGLE_CLOUD_REGION },
    { name: "PUBLIC_APP_URL", value: env.PUBLIC_APP_URL }
  ];
}

async function dispatchRemediationJob(
  action: RemediationAction,
  config: ServiceExecutionConfig,
  parameters: Record<string, string | number>
): Promise<string> {
  const jobName = cloudRunJobResource(action);
  const client = new JobsClient();
  const [operation] = await client.runJob({
    name: jobName,
    overrides: {
      containerOverrides: [
        {
          env: jobEnv({
            action,
            targetService: config.name,
            config,
            parameters
          })
        }
      ]
    }
  });
  await operation.promise();
  return `Cloud Run remediation job ${jobName} completed for ${config.name}`;
}

export async function executeRemediation(input: unknown): Promise<ExecuteRemediationResult> {
  assertProductionSafeRuntime("Sentinel remediation executor");
  const parsed = executeRemediationInputSchema.parse(input);
  invocationStarted("execute_remediation", parsed);
  const executedAt = new Date();
  const riskLevel = riskFromParameters(parsed.parameters);
  const orgId = parameterString(parsed.parameters, "orgId");
  let result: ExecuteRemediationResult;
  try {
    const config = await serviceConfig(parsed.targetService, orgId);
    if (riskLevel !== "low") {
      const output = await postSlackMessage(config, {
        action: parsed.action,
        targetService: parsed.targetService,
        parameters: parsed.parameters,
        approvalRequired: true
      });
      result = {
        success: false,
        action: parsed.action,
        targetService: parsed.targetService,
        executedAt,
        output,
        requiresHumanApproval: true
      };
      await logExecution({ ...parsed, riskLevel, success: false, output, requiresHumanApproval: true, executedAt, ...(orgId ? { orgId } : {}) });
      invocationFinished("execute_remediation", result);
      return result;
    }
    validateConfigForAction(parsed.action, config);
    const localEscalationMessage = parsed.action === "notify_team" ? parameterString(parsed.parameters, "escalationMessage") : undefined;
    const output = isLocalVerifyMode()
      ? localEscalationMessage
        ? `Local verification Slack notification:\n${localEscalationMessage}`
        : `Local verification recorded ${parsed.action} for ${config.name}; external dispatch skipped.`
      : parsed.action === "notify_team"
        ? await postSlackMessage(config, {
          action: parsed.action,
          targetService: parsed.targetService,
          parameters: parsed.parameters,
          approvalRequired: false
        })
        : await dispatchRemediationJob(parsed.action, config, parsed.parameters);
    result = {
      success: true,
      action: parsed.action,
      targetService: parsed.targetService,
      executedAt,
      output,
      requiresHumanApproval: false
    };
    await logExecution({ ...parsed, riskLevel, success: true, output, requiresHumanApproval: false, executedAt, ...(orgId ? { orgId } : {}) });
    invocationFinished("execute_remediation", result);
    return result;
  } catch (error: unknown) {
    const output = error instanceof Error ? error.message : "Unknown remediation failure";
    await logExecution({
      ...parsed,
      riskLevel,
      success: false,
      output,
      requiresHumanApproval: riskLevel !== "low",
      executedAt,
      ...(orgId ? { orgId } : {})
    });
    result = {
      success: false,
      action: parsed.action,
      targetService: parsed.targetService,
      executedAt,
      output,
      requiresHumanApproval: riskLevel !== "low"
    };
    invocationFailed("execute_remediation", error);
    invocationFinished("execute_remediation", result);
    return result;
  }
}

export const executeRemediationDefinition: AgentToolDefinition = {
  name: "execute_remediation",
  description: "Execute one remediation action with low-risk automatic execution and Slack approval for higher risk.",
  inputSchema: executeRemediationSchema
};

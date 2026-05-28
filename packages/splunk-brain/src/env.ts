import { loadRootEnv } from "@operaiq/shared";
import { z } from "zod";

loadRootEnv();

const splunkEnvSchema = z.object({
  SPLUNK_HOST: z.string().min(1).default("localhost"),
  SPLUNK_MGMT_URL: z.string().url().optional(),
  SPLUNK_HEC_URL: z.string().url().optional(),
  SPLUNK_MGMT_PORT: z.coerce.number().int().positive().default(8089),
  SPLUNK_HEC_PORT: z.coerce.number().int().positive().default(8088),
  SPLUNK_HEC_PROTOCOL: z.enum(["http", "https"]).default("https"),
  SPLUNK_USERNAME: z.string().min(1),
  SPLUNK_PASSWORD: z.string().min(1),
  SPLUNK_HEC_TOKEN: z.string().min(1),
  SPLUNK_GATEWAY_TOKEN: z.string().min(1).optional(),
  SPLUNK_CF_ACCESS_CLIENT_ID: z.string().min(1).optional(),
  SPLUNK_CF_ACCESS_CLIENT_SECRET: z.string().min(1).optional(),
  SPLUNK_APP: z.string().min(1).default("sentinel"),
  SPLUNK_INDEX: z.string().min(1).default("sentinel")
});

export type SplunkEnv = z.infer<typeof splunkEnvSchema>;

export function getSplunkEnv(): SplunkEnv {
  return splunkEnvSchema.parse(process.env);
}

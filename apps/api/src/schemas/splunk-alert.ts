import { z } from "zod";

const splunkResultValue = z.union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))]);

export const SplunkAlertPayload = z.object({
  result: z
    .object({
      sourcetype: splunkResultValue.optional(),
      host: splunkResultValue.optional(),
      source: splunkResultValue.optional(),
      service: splunkResultValue.optional(),
      severity: splunkResultValue.optional(),
      _raw: splunkResultValue.optional()
    })
    .passthrough(),
  results_link: z.string().url(),
  search_name: z.string(),
  owner: z.string(),
  app: z.string(),
  configuration: z.record(z.string()).optional()
}).passthrough();

export type SplunkAlertPayload = z.infer<typeof SplunkAlertPayload>;

import { z } from "zod";

export const SplunkAlertPayload = z.object({
  result: z
    .object({
      sourcetype: z.string().optional(),
      host: z.string().optional(),
      source: z.string().optional(),
      service: z.string().optional(),
      severity: z.string().optional(),
      _raw: z.string().optional()
    })
    .passthrough(),
  results_link: z.string().url(),
  search_name: z.string(),
  owner: z.string(),
  app: z.string(),
  configuration: z.record(z.string()).optional()
});

export type SplunkAlertPayload = z.infer<typeof SplunkAlertPayload>;

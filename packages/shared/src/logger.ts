import pino from "pino";

export function createLogger(name: string) {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "SPLUNK_PASSWORD",
        "SPLUNK_HEC_TOKEN",
        "SLACK_BOT_TOKEN",
        "SLACK_SIGNING_SECRET",
        "MONGODB_ATLAS_URI",
        "*.SPLUNK_PASSWORD",
        "*.SPLUNK_HEC_TOKEN",
        "*.SLACK_BOT_TOKEN",
        "*.SLACK_SIGNING_SECRET",
        "*.MONGODB_ATLAS_URI"
      ],
      censor: "[redacted]"
    },
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime
  });
}

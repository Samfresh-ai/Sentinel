import pino from "pino";

export function createLogger(name: string) {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "SPLUNK_PASSWORD",
        "SPLUNK_HEC_TOKEN",
        "QDRANT_API_KEY",
        "NVIDIA_API_KEY",
        "OPENAI_API_KEY",
        "SLACK_BOT_TOKEN",
        "SLACK_SIGNING_SECRET",
        "*.SPLUNK_PASSWORD",
        "*.SPLUNK_HEC_TOKEN",
        "*.QDRANT_API_KEY",
        "*.NVIDIA_API_KEY",
        "*.OPENAI_API_KEY",
        "*.SLACK_BOT_TOKEN",
        "*.SLACK_SIGNING_SECRET"
      ],
      censor: "[redacted]"
    },
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime
  });
}

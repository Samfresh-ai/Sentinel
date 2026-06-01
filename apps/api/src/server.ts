import { assertProductionSafeRuntime, createLogger } from "@sentinel/shared";
import { createApp } from "./app.js";

const logger = createLogger("operaiq-api-server");

async function main(): Promise<void> {
  assertProductionSafeRuntime("OperaIQ API");
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);
  const app = createApp();
  app.listen(port, () => {
    logger.info({ port }, "OperaIQ API listening");
  });
}

main().catch((error: unknown) => {
  logger.fatal({ error }, "OperaIQ API failed to start");
  process.exitCode = 1;
});

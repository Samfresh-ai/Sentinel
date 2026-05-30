import { createCollectionsAndIndexes } from "@operaiq/brain";
import { assertProductionSafeRuntime, createLogger } from "@operaiq/shared";
import { createApp } from "./app.js";

const logger = createLogger("sentinel-api-server");

async function main(): Promise<void> {
  assertProductionSafeRuntime("Sentinel API");
  await createCollectionsAndIndexes();
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);
  const app = createApp();
  app.listen(port, () => {
    logger.info({ port }, "Sentinel API listening");
  });
}

main().catch((error: unknown) => {
  logger.fatal({ error }, "Sentinel API failed to start");
  process.exitCode = 1;
});

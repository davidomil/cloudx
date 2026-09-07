import { loadConfig } from "./config.js";
import { ProcessShutdownController } from "./lifecycle/ProcessShutdownController.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const app = await buildServer(config);
const shutdown = new ProcessShutdownController(
  () => app.close(),
  process,
  (error) => {
    console.error("CloudX shutdown failed.", error);
    process.exitCode = 1;
  }
);
shutdown.start();

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  shutdown.dispose();
  throw error;
}

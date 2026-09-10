import { loadConfig } from "../../../apps/server/dist/config.js";
import { ProcessShutdownController } from "../../../apps/server/dist/lifecycle/ProcessShutdownController.js";
import {
  buildServer,
  buildServices,
} from "../../../apps/server/dist/server.js";

const config = loadConfig();
const services = buildServices(config);
const app = await buildServer(config, services);
const shutdown = new ProcessShutdownController(
  () => app.close(),
  process,
  (error) => {
    console.error("Catalog browser server shutdown failed.", error);
    process.exitCode = 1;
  },
);
shutdown.start();

try {
  // Fixture commits must include every plugin-contributed rule and skill.
  await services.pluginContributionsReady;
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await shutdown.shutdown();
  throw error;
}

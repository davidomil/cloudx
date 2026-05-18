import { loadConfig, networkBindWarning, shouldWarnForNetworkBind } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
if (shouldWarnForNetworkBind(config.host)) {
  console.warn(networkBindWarning(config.host, config.port));
}
const app = await buildServer(config);

await app.listen({ host: config.host, port: config.port });

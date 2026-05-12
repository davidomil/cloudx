import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const app = await buildServer(config);

await app.listen({ host: config.host, port: config.port });

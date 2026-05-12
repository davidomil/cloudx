import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("defaults to LAN/Tailscale-facing host and port", () => {
    const config = loadConfig({ HOME: "/workspace/test" } as NodeJS.ProcessEnv);

    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(3001);
  });
});

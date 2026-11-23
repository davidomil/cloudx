import Fastify from "fastify";
import { expect, it } from "vitest";
import { TerminalMemoryError } from "./TerminalMemoryService.js";
import { registerTerminalMemoryRoutes } from "./TerminalMemoryRoutes.js";

it("protects live host changes with the trusted browser origin and propagates validation/application failures", async () => {
  const app = Fastify();
  let applies = 0;
  registerTerminalMemoryRoutes(app, {
    status: async () => ({ manageable: false, reason: "Unsupported installation" }) as never,
    apply: async body => { applies++; throw new TerminalMemoryError(body ? "Access denied" : "Invalid memory values", body ? 503 : 400); }
  }, ["http://localhost:3001"]);
  try {
    const read = await app.inject({ method: "GET", url: "/api/terminal-memory" });
    expect(read.statusCode).toBe(200); expect(read.headers["cache-control"]).toBe("no-store");
    expect(read.json().reason).toBe("Unsupported installation");
    for (const origin of [undefined, "http://attacker.example"]) {
      expect((await app.inject({ method: "PUT", url: "/api/terminal-memory", headers: origin ? { origin } : {}, payload: {} })).statusCode).toBe(403);
    }
    expect(applies).toBe(0);
    const denied = await app.inject({ method: "PUT", url: "/api/terminal-memory", headers: { origin: "http://localhost:3001" }, payload: {} });
    expect(denied.statusCode).toBe(503); expect(denied.json().message).toBe("Access denied");
    const invalid = await app.inject({ method: "PUT", url: "/api/terminal-memory", headers: { origin: "http://localhost:3001", "content-type": "application/json" }, payload: "null" });
    expect(invalid.statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/terminal-memory", headers: { origin: "http://localhost:3001" }, payload: { memoryHigh: "1".repeat(2000) } })).statusCode).toBe(413);
  } finally { await app.close(); }
});

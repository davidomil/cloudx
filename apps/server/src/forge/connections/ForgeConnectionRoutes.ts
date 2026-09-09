import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ForgeCredentialRole, ForgeRepository } from "@cloudx/shared";
import { forgeSetupCookieName, type ForgeConnectionService } from "./ForgeConnectionService.js";

const repositorySchema = {
  type: "object", additionalProperties: false, required: ["provider", "apiUrl", "projectPath"],
  properties: {
    provider: { type: "string", enum: ["github", "gitlab"] },
    apiUrl: { type: "string", minLength: 1, maxLength: 2048 },
    projectPath: { type: "string", minLength: 1, maxLength: 512 },
  },
};

export function registerForgeConnectionRoutes(app: FastifyInstance, connections: ForgeConnectionService, trustedOrigins: string[]): void {
  const browserOrigin = (request: FastifyRequest): string => {
    const origin = request.headers.origin;
    if (!origin || !trustedOrigins.includes(origin)) throw Object.assign(new Error("Open Forge settings from a trusted CloudX browser origin."), { statusCode: 403 });
    return origin;
  };
  app.get("/api/forge/connections", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return connections.status();
  });
  app.post<{ Body: { repository: ForgeRepository; role: ForgeCredentialRole } }>("/api/forge/connections/github/start", {
    bodyLimit: 8192,
    schema: { body: { type: "object", additionalProperties: false, required: ["repository", "role"], properties: { repository: repositorySchema, role: { type: "string", enum: ["worker", "reviewer"] } } } },
  }, async (request, reply) => {
    const { action, cookie } = await connections.beginGitHub(request.body.repository, request.body.role, browserOrigin(request));
    reply.header("set-cookie", cookie).header("cache-control", "no-store");
    return action;
  });
  app.post<{ Body: { repository: ForgeRepository; setupToken: string } }>("/api/forge/connections/gitlab", {
    bodyLimit: 8192,
    schema: { body: { type: "object", additionalProperties: false, required: ["repository", "setupToken"], properties: { repository: repositorySchema, setupToken: { type: "string", minLength: 1, maxLength: 4096 } } } },
  }, async (request, reply) => {
    browserOrigin(request);
    reply.header("cache-control", "no-store");
    return connections.provisionGitLab(request.body.repository, request.body.setupToken);
  });
  for (const kind of ["manifest", "installation"] as const) {
    const value = kind === "manifest" ? "code" : "installation_id";
    app.get<{ Querystring: Record<string, string> }>(`/api/forge/connections/github/${kind}`, {
      schema: { querystring: { type: "object", required: ["state", value], properties: { state: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }, [value]: { type: "string", minLength: 1, maxLength: 512 } } } },
    }, async (request, reply) => {
      reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer").header("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      const { state } = request.query;
      try {
        const cookie = registrationCookie(request.headers.cookie, state!);
        if (kind === "manifest") {
          const url = await connections.completeGitHubManifest(state!, request.query.code!, cookie, trustedOrigins);
          return reply.redirect(url);
        }
        await connections.completeGitHubInstallation(state!, request.query.installation_id!, cookie, trustedOrigins);
        reply.header("set-cookie", `${forgeSetupCookieName(state!)}=; HttpOnly; SameSite=Lax; Path=/api/forge/connections; Max-Age=0${request.protocol === "https" ? "; Secure" : ""}`);
        return reply.type("text/html").send(page("Application connected", "Return to CloudX Settings. This window can be closed."));
      } catch {
        return reply.code(400).type("text/html").send(page("Application setup needs attention", "Return to CloudX Settings for the current connection status. The callback was rejected or setup could not be verified."));
      }
    });
  }
}

function registrationCookie(header: string | undefined, state: string): string | undefined {
  const name = forgeSetupCookieName(state);
  const values = (header ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  return values[0]!.slice(name.length + 1);
}
function page(title: string, text: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><h1>${title}</h1><p>${text}</p></html>`;
}

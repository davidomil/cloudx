import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";

export const UPDATE_SERVICE_NAMES = [
  "cloudx-asr.service",
  "cloudx-documentation.service",
  "cloudx.service",
];
export const TERMINAL_SERVICE_NAME = "cloudx-terminal.service";
export const SERVICE_NAMES = [...UPDATE_SERVICE_NAMES, TERMINAL_SERVICE_NAME];

export function updatePort(value, label = "Port") {
  if (
    !/^\d+$/.test(String(value)) ||
    Number(value) < 1 ||
    Number(value) > 65535
  ) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
  }
  return Number(value);
}

export function updateHost(value) {
  const version = typeof value === "string" ? isIP(value) : 0;
  if (!version || value.includes("%")) {
    throw new Error(
      "--host requires an IPv4 or IPv6 address without brackets or a zone identifier.",
    );
  }
  if (version === 4) return value === "0.0.0.0" ? "127.0.0.1" : value;
  const host = new URL(`https://[${value}]`).hostname.slice(1, -1);
  return host === "::" ? "::1" : host;
}

export function documentationReadinessUrl(envConfig) {
  const port = updatePort(
    envConfig.CLOUDX_DOCUMENTATION_PORT ?? 7820,
    "Documentation port",
  );
  const configuredHost = envConfig.CLOUDX_DOCUMENTATION_HOST ?? "127.0.0.1";
  const host =
    configuredHost === "0.0.0.0"
      ? "127.0.0.1"
      : configuredHost === "::"
        ? "::1"
        : configuredHost;
  const authority =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return new URL(`http://${authority}:${port}/ready`).href;
}

function samePath(actual, expected) {
  return (
    path.isAbsolute(actual) &&
    fs.existsSync(actual) &&
    fs.existsSync(expected) &&
    fs.realpathSync(actual) === fs.realpathSync(expected)
  );
}

function inspectService(commands, name, root, allowMissing = false) {
  const output = commands.inspect("systemctl", [
    "--user",
    "show",
    name,
    "--property=Id,LoadState,WorkingDirectory,EnvironmentFiles,FragmentPath,NeedDaemonReload,DropInPaths",
  ]);
  const properties = Object.fromEntries(
    output
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => [
        line.slice(0, line.indexOf("=")),
        line.slice(line.indexOf("=") + 1),
      ]),
  );
  if (allowMissing && properties.LoadState === "not-found") return undefined;
  if (properties.LoadState !== "loaded") {
    throw new Error(
      `${name} must be an existing, loaded user service before updating.`,
    );
  }
  if (properties.NeedDaemonReload !== "no") {
    throw new Error(
      `${name} has an unconfirmed service definition. Run systemctl --user daemon-reload and inspect the service before updating.`,
    );
  }
  if (!samePath(properties.WorkingDirectory ?? "", root)) {
    throw new Error(
      `${name} belongs to another checkout (${properties.WorkingDirectory || "no WorkingDirectory"}). Run the updater from that checkout, or explicitly select this checkout's web service with --service and --port.`,
    );
  }
  return properties;
}

export function inspectUpdateTarget({ paths, commands, service, port, host }) {
  if (service) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.service$/.test(service)) {
      throw new Error(
        "--service requires a user service name ending in .service.",
      );
    }
    const healthPort = updatePort(port, "--port");
    const healthHost = updateHost(host ?? "127.0.0.1");
    const authority = isIP(healthHost) === 6 ? `[${healthHost}]` : healthHost;
    inspectService(commands, service, paths.repoRoot);
    return {
      kind: "web",
      serviceNames: [service],
      servicesInstalled: true,
      port: healthPort,
      origin: `https://${authority}:${healthPort}`,
    };
  }
  if (port !== undefined || host !== undefined)
    throw new Error("--port and --host require --service for an update.");
  if (!fs.existsSync(paths.envPath)) {
    throw new Error(
      `Saved Cloudx configuration is missing: ${paths.envPath}. Run the installer first, or use --service and --port for an existing custom web service.`,
    );
  }
  const installed = [];
  for (const name of SERVICE_NAMES) {
    const properties = inspectService(
      commands,
      name,
      paths.repoRoot,
      !fs.existsSync(path.join(paths.systemdDir, name)),
    );
    if (!properties) continue;
    installed.push(name);
    const environmentFile =
      /^(.*) \(ignore_errors=no\)$/.exec(
        properties.EnvironmentFiles ?? "",
      )?.[1] ?? "";
    if (
      properties.DropInPaths ||
      !samePath(
        properties.FragmentPath ?? "",
        path.join(paths.systemdDir, name),
      ) ||
      !samePath(environmentFile, paths.envPath)
    ) {
      throw new Error(
        `${name} does not match the standard Cloudx unit and environment file. Use --service and --port to preserve a custom web service definition.`,
      );
    }
  }
  return {
    kind: "standard",
    serviceNames: SERVICE_NAMES,
    servicesInstalled: installed.length > 0,
  };
}

export function updateCheckout(
  commands,
  { repoRoot, dryRun = false, updatedCommit },
) {
  const gitRoot = commands.inspect("git", ["rev-parse", "--show-toplevel"]);
  if (!samePath(gitRoot, repoRoot))
    throw new Error("Run the updater from the Cloudx checkout root.");
  if (
    commands.inspect("git", [
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ])
  ) {
    throw new Error(
      "The checkout has local changes. Commit or move them before updating; no local work was changed.",
    );
  }
  const head = commands.inspect("git", ["rev-parse", "HEAD"]);
  if (updatedCommit) {
    if (head !== updatedCommit)
      throw new Error(
        "The checkout changed while reloading the updated installer. Run the update again.",
      );
    return head;
  }
  commands.inspect("git", ["remote", "get-url", "origin"]);
  commands.run("git", [
    "fetch",
    "--no-tags",
    "origin",
    "+refs/heads/main:refs/remotes/origin/main",
  ]);
  if (dryRun) {
    commands.run("git", [
      "merge",
      "--ff-only",
      "--no-edit",
      "refs/remotes/origin/main",
    ]);
    return undefined;
  }
  const target = commands.inspect("git", [
    "rev-parse",
    "refs/remotes/origin/main^{commit}",
  ]);
  if (
    !commands.statusOk("git", ["merge-base", "--is-ancestor", head, target])
  ) {
    throw new Error(
      "This checkout contains commits not contained in origin/main. Resolve the branch before updating; no commits were reset or merged.",
    );
  }
  commands.run("git", ["merge", "--ff-only", "--no-edit", target]);
  if (commands.inspect("git", ["rev-parse", "HEAD"]) !== target) {
    throw new Error(
      "The checkout changed during the update. Resolve local work before running the updater again.",
    );
  }
  return target;
}

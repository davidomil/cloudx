import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it, onTestFinished } from "vitest";
import { InstallerRunner, waitForHealth } from "./install-cloudx.mjs";

async function readinessServer({
  unavailableRequests = 0,
  responseStatus = 200,
  listenDelayMs = 0,
  hang = false,
} = {}) {
  const requests = new Int32Array(new SharedArrayBuffer(4));
  const worker = new Worker(
    `
    const http = require("node:http");
    const { parentPort, workerData } = require("node:worker_threads");
    const server = http.createServer((_request, response) => {
      const count = Atomics.add(workerData.requests, 0, 1) + 1;
      if (workerData.hang) return;
      response.writeHead(count <= workerData.unavailableRequests ? 503 : workerData.responseStatus);
      response.end(JSON.stringify({ status: response.statusCode === 200 ? "ready" : "not-ready" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      if (workerData.listenDelayMs) {
        server.close(() => {
          parentPort.postMessage(port);
          setTimeout(() => server.listen(port, "127.0.0.1"), workerData.listenDelayMs);
        });
      } else {
        parentPort.postMessage(port);
      }
    });
  `,
    {
      eval: true,
      workerData: {
        requests,
        unavailableRequests,
        responseStatus,
        listenDelayMs,
        hang,
      },
    },
  );
  onTestFinished(() => worker.terminate());
  const [port] = await once(worker, "message");
  return { url: `http://127.0.0.1:${port}/ready`, requests };
}

it("waits for readiness beyond the old thirty-second startup window", async () => {
  const { url, requests } = await readinessServer({ unavailableRequests: 31 });
  const commands = new InstallerRunner({ log: () => {} });

  expect(() =>
    waitForHealth(commands, { label: "Documentation", url }),
  ).not.toThrow();
  expect(Atomics.load(requests, 0)).toBe(32);
}, 45_000);

it("waits for an indexer that has not opened its listener yet", async () => {
  const { url, requests } = await readinessServer({ listenDelayMs: 1500 });
  const commands = new InstallerRunner({ log: () => {} });

  expect(() =>
    waitForHealth(commands, { label: "Documentation", url }),
  ).not.toThrow();
  expect(Atomics.load(requests, 0)).toBe(1);
});

it("reports the service and endpoint when readiness stays unavailable", async () => {
  const { url } = await readinessServer({ responseStatus: 503 });
  const commands = new InstallerRunner({ log: () => {} });

  expect(() =>
    waitForHealth(commands, {
      label: "Documentation",
      url,
      startupTimeoutSeconds: 1,
    }),
  ).toThrow(
    `Documentation readiness verification failed at ${url} (startup budget: 1s). Command failed (exit code 22)`,
  );
});

it("bounds a stalled request and stops polling when the startup budget is exhausted", async () => {
  const { url, requests } = await readinessServer({ hang: true });
  const commands = new InstallerRunner({ log: () => {} });

  expect(() =>
    waitForHealth(commands, {
      label: "Documentation",
      url,
      startupTimeoutSeconds: 1,
    }),
  ).toThrow("Command failed (exit code 28)");
  expect(Atomics.load(requests, 0)).toBe(1);
}, 10_000);

it("fails immediately for an endpoint that does not provide readiness", async () => {
  const { url, requests } = await readinessServer({ responseStatus: 404 });
  const commands = new InstallerRunner({ log: () => {} });

  expect(() =>
    waitForHealth(commands, { label: "Documentation", url }),
  ).toThrow("Command failed (exit code 22)");
  expect(Atomics.load(requests, 0)).toBe(1);
});

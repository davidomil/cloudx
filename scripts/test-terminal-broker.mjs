import { fork } from "node:child_process";

export async function startTerminalBroker(modulePath, { onSpawn, ...options }) {
  const child = fork(modulePath, [], options);
  try {
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("The test terminal broker did not become ready within 10 seconds.")), 10_000);
      function finish(error) {
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolve();
      }
      function onMessage(message) {
        if (message?.type === "ready") finish();
      }
      function onError(error) { finish(error); }
      function onExit(code, signal) {
        finish(new Error(`The test terminal broker exited before readiness (${signal ?? code}).`));
      }
      child.on("message", onMessage);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    await Promise.all([ready, Promise.resolve().then(() => onSpawn?.(child))]);
    child.disconnect();
    return child;
  } catch (error) {
    await stopTestProcess(child);
    throw error;
  }
}

export async function stopTestProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`Test process ${child.pid} did not stop after SIGTERM.`));
    }, 5_000);
    function onExit() {
      clearTimeout(timer);
      resolve();
    }
    child.once("exit", onExit);
    child.kill("SIGTERM");
  });
}

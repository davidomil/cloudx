import { describe, expect, it, vi } from "vitest";

import { AppServerContextProvider } from "./AppServerContextProvider.js";

describe("AppServerContextProvider", () => {
  it("closes the lazily-created app-server client when disposed", async () => {
    const close = vi.fn();
    const readVoiceContext = vi.fn(async () => ({ threads: { data: [] } }));
    const sessions = {
      async buildVoiceContext() {
        return { workspace: true };
      },
      getTab() {
        return { cwd: "/tmp/project" };
      }
    };
    const provider = new AppServerContextProvider(sessions as never, () => ({ readVoiceContext, close }) as never);

    await expect(provider.context("tab-1")).resolves.toMatchObject({ appServer: { enabled: true } });
    provider.dispose();

    expect(readVoiceContext).toHaveBeenCalledWith("/tmp/project");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("recreates a closed app-server client after a failed context read", async () => {
    const failedClient = {
      isClosed: true,
      close: vi.fn(),
      readVoiceContext: vi.fn(async () => {
        throw new Error("spawn ENOENT");
      })
    };
    const recoveredClient = {
      isClosed: false,
      close: vi.fn(),
      readVoiceContext: vi.fn(async () => ({ threads: { data: [{ id: "thread-1" }] } }))
    };
    const factory = vi.fn()
      .mockReturnValueOnce(failedClient)
      .mockReturnValueOnce(recoveredClient);
    const sessions = {
      async buildVoiceContext() {
        return { workspace: true };
      },
      getTab() {
        return { cwd: "/tmp/project" };
      }
    };
    const provider = new AppServerContextProvider(sessions as never, factory);

    await expect(provider.context("tab-1")).resolves.toMatchObject({
      appServer: { enabled: true, error: "spawn ENOENT" }
    });
    await expect(provider.context("tab-1")).resolves.toMatchObject({
      appServer: { enabled: true, threads: { data: [{ id: "thread-1" }] } }
    });

    expect(factory).toHaveBeenCalledTimes(2);
    expect(failedClient.readVoiceContext).toHaveBeenCalledTimes(1);
    expect(recoveredClient.readVoiceContext).toHaveBeenCalledTimes(1);
  });
});

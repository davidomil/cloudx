import type { IPty } from "node-pty";
import { describe, expect, it, vi } from "vitest";

import { NodePtyTerminalProcess } from "./NodePtyTerminalProcess.js";

describe("NodePtyTerminalProcess", () => {
  it("does not resize a terminal after its exit event", () => {
    const { terminal, native, exit } = terminalFixture();
    terminal.resize(100, 30);
    exit();
    native.resize.mockImplementation(() => { throw new Error("ioctl(2) failed, ENOTTY"); });

    expect(() => terminal.resize(120, 40)).not.toThrow();
    expect(native.resize).toHaveBeenCalledExactlyOnceWith(100, 30);
  });

  it.each(["ENOTTY", "EBADF"])("tolerates %s during the native close race without declaring the process exited", (code) => {
    const { terminal, native } = terminalFixture();
    native.resize.mockImplementation(() => { throw new Error(`ioctl(2) failed, ${code}`); });

    expect(() => terminal.resize(120, 40)).not.toThrow();
    terminal.kill();
    expect(native.kill).toHaveBeenCalledOnce();
  });

  it.each(["ioctl(2) failed, EINVAL", "ioctl(2) failed, EFAULT", "Unexpected resize failure"])("preserves unexpected resize errors: %s", (message) => {
    const { terminal, native } = terminalFixture();
    const failure = new Error(message);
    native.resize.mockImplementation(() => { throw failure; });

    expect(() => terminal.resize(120, 40)).toThrow(failure);
  });
});

function terminalFixture() {
  let exit!: () => void;
  const native = {
    pid: 2_147_483_647,
    onExit: (listener: () => void) => { exit = listener; return { dispose() {} }; },
    onData: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn()
  };
  const supervisor = { completion: new Promise<{ event: { exitCode: number } }>(() => {}), kill: () => native.kill(), terminate: async () => {} };
  const terminal = new NodePtyTerminalProcess(native as unknown as IPty, supervisor);
  return { terminal, native, exit: () => exit() };
}

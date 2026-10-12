import { describe, expect, it } from "vitest";
import { MAX_TERMINAL_CLIPBOARD_BYTES, terminalClipboardText } from "./terminalClipboardRequest.js";

const encoded = (text: string) => Buffer.from(text).toString("base64");

describe("terminal application clipboard text", () => {
  it.each(["c", ""])("accepts UTF-8 plain text for clipboard target %j", target => {
    const text = "界 café\n\tcode\r\n";
    expect(terminalClipboardText(`${target};${encoded(text)}`)).toBe(text);
  });

  it("accepts the supported Codex byte limit and rejects one byte above it", () => {
    const text = "x".repeat(MAX_TERMINAL_CLIPBOARD_BYTES);
    expect(terminalClipboardText(`c;${encoded(text)}`)).toBe(text);
    expect(() => terminalClipboardText(`c;${encoded(text + "x")}`)).toThrow("exceeds 100,000 bytes");
    expect(() => terminalClipboardText(`c;${"x".repeat(200_000)}`)).toThrow("exceeds 100,000 bytes");
  });

  it.each(["c;?", "p;?", "p;YQ==", "cp;YQ==", "c", "c;", "c;YQ=", "c;Y!==", "c;YR==", "c;YQ==;YQ=="])("rejects read, unsupported-target or malformed request %j", payload => {
    expect(() => terminalClipboardText(payload)).toThrow();
  });

  it.each(["hello\u0000", "hello\u001b[31m", "hello\u0007", "hello\u007f", "hello\u0085", "hello\u202e", "hello\u2066"])("rejects unsafe control text %j", text => {
    expect(() => terminalClipboardText(`c;${encoded(text)}`)).toThrow("unsafe control characters");
  });

  it("rejects invalid UTF-8 rather than copying replacement characters", () => {
    expect(() => terminalClipboardText("c;/w==")).toThrow("not valid UTF-8");
  });
});

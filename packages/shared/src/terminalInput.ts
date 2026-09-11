/** Keeps pasted input below the websocket's 256 KiB encoded-message limit. */
export function* terminalInputMessages(data: string): Generator<string> {
  for (let start = 0; start < data.length;) {
    // JSON can expand one UTF-16 code unit into six bytes (for example, NUL).
    let end = Math.min(start + 32_768, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    yield JSON.stringify({ type: "input", data: data.slice(start, end) });
    start = end;
  }
}

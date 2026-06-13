const UUID_BYTES = 16;

export function createBrowserId(prefix: string): string {
  return `${prefix}-${createBrowserUuid()}`;
}

export function createBrowserUuid(): string {
  const bytes = new Uint8Array(UUID_BYTES);
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new Error("Browser random values are required to create workspace ids.");
  }
  cryptoApi.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

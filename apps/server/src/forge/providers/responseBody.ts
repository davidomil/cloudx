import { ForgeProviderError } from "./ForgeProvider.js";

export async function readBoundedBody(
  response: Response,
  limit = 5_000_000,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit)
        throw new ForgeProviderError(
          `The forge response exceeds the ${limit / 1_000_000} MB limit.`,
          422,
        );
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks).toString("utf8");
}

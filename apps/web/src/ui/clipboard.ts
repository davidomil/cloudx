export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export async function copyTextToClipboard(text: string, clipboard: ClipboardWriter | undefined = typeof navigator === "undefined" ? undefined : navigator.clipboard): Promise<void> {
  if (!clipboard?.writeText) {
    throw new Error("Clipboard API is not available in this browser context.");
  }
  await clipboard.writeText(text);
}

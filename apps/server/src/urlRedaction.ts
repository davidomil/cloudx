const URL_IN_TEXT_PATTERN = /https?:\/\/[^\s<>"']+/gi;

export function redactUrlSearchAndHash(input: string): string {
  try {
    const parsed = new URL(input);
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return removeSearchAndHash(input);
  }
}

export function redactUrlSearchAndHashInText(input: string): string {
  return input.replace(URL_IN_TEXT_PATTERN, (url) => redactUrlSearchAndHash(url));
}

function removeSearchAndHash(input: string): string {
  const searchIndex = input.indexOf("?");
  const hashIndex = input.indexOf("#");
  const indexes = [searchIndex, hashIndex].filter((index) => index >= 0);
  if (indexes.length === 0) {
    return input;
  }
  return input.slice(0, Math.min(...indexes));
}

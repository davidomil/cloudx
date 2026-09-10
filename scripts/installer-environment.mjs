// EnvironmentFile syntax is data syntax: no shell expansion or execution.
export function parseEnvironmentFile(content) {
  return Object.fromEntries(
    assignments(content)
      .filter(({ key }) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      .map(({ key, value }) => [key, value]),
  );
}

export function updateEnvironmentFile(content, updates) {
  const seen = new Set();
  let output = "";
  let cursor = 0;
  for (const assignment of assignments(content)) {
    output += content.slice(cursor, assignment.start);
    if (Object.hasOwn(updates, assignment.key)) {
      output += `${assignment.key}=${encodeValue(updates[assignment.key])}\n`;
      seen.add(assignment.key);
    } else if (!assignment.terminated) {
      output += `${assignment.key}=${encodeValue(assignment.value)}\n`;
    } else {
      output += content.slice(assignment.start, assignment.end);
    }
    cursor = assignment.end;
  }
  output += content.slice(cursor);
  if (output && !/[\r\n]$/.test(output)) output += "\n";
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new Error("Invalid environment variable name.");
    if (!seen.has(key)) output += `${key}=${encodeValue(value)}\n`;
  }
  return output || "\n";
}

function assignments(content) {
  if (content.includes("\0"))
    throw new Error("EnvironmentFile contains a NUL character.");
  const entries = [];
  let offset = 0;
  while (offset < content.length) {
    const start = offset;
    const newline = content.slice(start).search(/[\r\n]/);
    const lineEnd = newline === -1 ? content.length : start + newline;
    const line = content.slice(start, lineEnd).replace(/^[ \t]+|[ \t]+$/g, "");
    offset = newline === -1 ? lineEnd : lineEnd + 1;
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const keyStart = start + content.slice(start, lineEnd).search(/[^ \t]/);
    const separator = content.indexOf("=", keyStart + 1);
    if (separator === -1 || separator >= lineEnd) continue;
    const key = content.slice(keyStart, separator).replace(/[ \t]+$/g, "");
    const result = readValue(content, separator + 1);
    offset = result.end;
    entries.push({ key, start, ...result });
  }
  return entries;
}

function readValue(content, offset) {
  let state = "before";
  let value = "";
  let trailingWhitespace;
  let terminated = false;
  while (offset < content.length) {
    const character = content[offset++];
    if (state === "single") {
      if (character === "'") state = "before";
      else value += character;
    } else if (state === "double") {
      if (character === '"') state = "before";
      else if (character === "\\") state = "double escape";
      else value += character;
    } else if (state === "double escape") {
      if (character !== "\n")
        value += '\\"`$'.includes(character) ? character : `\\${character}`;
      state = "double";
    } else if (state === "escape") {
      if (!"\r\n".includes(character)) value += character;
      state = "unquoted";
    } else if ("\r\n".includes(character)) {
      if (character === "\r" && content[offset] === "\n") offset++;
      terminated = true;
      break;
    } else if (character === "\\") {
      trailingWhitespace = undefined;
      state = "escape";
    } else if (state === "before") {
      if (character === "'") state = "single";
      else if (character === '"') state = "double";
      else if (!" \t\r".includes(character)) {
        value += character;
        state = "unquoted";
      }
    } else {
      if (" \t\r".includes(character)) trailingWhitespace ??= value.length;
      else trailingWhitespace = undefined;
      value += character;
    }
  }
  return {
    value:
      trailingWhitespace === undefined
        ? value
        : value.slice(0, trailingWhitespace),
    end: offset,
    terminated,
  };
}

function encodeValue(value) {
  const text = String(value);
  if (text.includes("\0"))
    throw new Error("Environment values cannot contain NUL characters.");
  if (/^[A-Za-z0-9_:/.,@%+=-]*$/.test(text)) return text;
  return `"${text.replace(/[\\"`$]/g, (character) => `\\${character}`)}"`;
}

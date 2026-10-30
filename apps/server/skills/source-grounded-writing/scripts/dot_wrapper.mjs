#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { Graphviz } from "@hpcc-js/wasm/graphviz";

function usage() {
  console.error("Usage: dot [-Tsvg|-Tpng] [input.dot] [-o output]");
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stdin.on("data", (chunk) => chunks.push(chunk));
    stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stdin.on("error", reject);
  });
}

const args = process.argv.slice(2);

if (args.includes("-V") || args.includes("--version")) {
  console.error("dot - graphviz version 9.0.0 (wasm)");
  process.exit(0);
}

let format = "svg";
let output = null;
let input = null;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg.startsWith("-T")) {
    format = arg.slice(2) || args[++index];
  } else if (arg === "-o") {
    output = args[++index];
  } else if (arg.startsWith("-")) {
    continue;
  } else {
    input = arg;
  }
}

if (!["svg", "png"].includes(format)) {
  usage();
  console.error(`Unsupported format: ${format}`);
  process.exit(2);
}

const dot = input ? readFileSync(input, "utf8") : await readStdin();
if (!dot.trim()) {
  usage();
  process.exit(2);
}

const graphviz = await Graphviz.load();
const rendered = graphviz.dot(dot, format);
const bytes = rendered instanceof Uint8Array ? Buffer.from(rendered) : Buffer.from(rendered, "utf8");

if (output) {
  writeFileSync(output, bytes);
} else {
  stdout.write(bytes);
}

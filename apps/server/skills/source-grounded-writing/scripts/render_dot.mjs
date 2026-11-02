#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";
import { Graphviz } from "@hpcc-js/wasm/graphviz";

const [input, output] = process.argv.slice(2);

if (!input || !output) {
  console.error("Usage: node scripts/render_dot.mjs <input.dot> <output.svg|png>");
  process.exit(1);
}

const dot = readFileSync(input, "utf8");
const graphviz = await Graphviz.load();
const ext = extname(output).toLowerCase();
const format = ext === ".png" ? "png" : "svg";
const rendered = graphviz.dot(dot, format);

if (rendered instanceof Uint8Array) {
  writeFileSync(output, Buffer.from(rendered));
} else {
  writeFileSync(output, rendered, "utf8");
}

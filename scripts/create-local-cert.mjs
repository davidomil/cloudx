#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.CLOUDX_DATA_DIR ?? path.join(repoRoot, ".cloudx"));
const certDir = path.join(dataDir, "certs");
const keyPath = path.join(certDir, "cloudx-local.key");
const certPath = path.join(certDir, "cloudx-local.crt");
const force = process.argv.includes("--force");

if (!force && fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  printResult("exists");
  process.exit(0);
}

fs.mkdirSync(certDir, { recursive: true });

const san = collectSubjectAlternativeNames();
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-days",
    process.env.CLOUDX_CERT_DAYS ?? "365",
    "-noenc",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=Cloudx Local",
    "-addext",
    `subjectAltName=${san.join(",")}`,
    "-addext",
    "keyUsage=digitalSignature,keyEncipherment",
    "-addext",
    "extendedKeyUsage=serverAuth"
  ],
  { stdio: "inherit" }
);

fs.chmodSync(keyPath, 0o600);
fs.chmodSync(certPath, 0o644);
printResult(force ? "regenerated" : "created");

function collectSubjectAlternativeNames() {
  const values = new Set(["localhost", "127.0.0.1", os.hostname(), ...localIPv4Addresses(), ...extraHosts()]);
  return Array.from(values)
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => (net.isIP(value) ? `IP:${value}` : `DNS:${value}`));
}

function localIPv4Addresses() {
  return Object.values(os.networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

function extraHosts() {
  return (process.env.CLOUDX_CERT_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

function printResult(status) {
  console.log(`Cloudx local certificate ${status}.`);
  console.log(`  key:  ${keyPath}`);
  console.log(`  cert: ${certPath}`);
  console.log("Trust the certificate on each browser/device that should use microphone capture.");
}

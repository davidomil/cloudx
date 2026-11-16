import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigSecretStore } from "../configSecretStore.js";
import { HardwareSshPasswords } from "./HardwareSshPasswords.js";
import { hardwareCredentialResolver } from "./hardwareCredentials.js";

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});
const reference = (kind = "registration") => `ssh-${kind}-${randomUUID()}`;
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-passwords-"));
  directories.push(root);
  return { root, passwords: new HardwareSshPasswords(root), secrets: new ConfigSecretStore(root) };
}
const legacyPasswords = (values: Record<string, string>) => ({ global: {}, plugins: { hardware: values } });

it("keeps a key setup password in memory without creating any secret file or digest", async () => {
  const { root, passwords } = await fixture();
  const credentialRefId = reference();
  const password = '  secret $`" \\ tab\t🌍  ';
  expect(await passwords.save(credentialRefId, password)).toEqual({ credentialRefId });
  expect(await passwords.resolve(credentialRefId)).toBe(password);
  expect(await fs.readdir(root)).toEqual([]);
  await expect(new HardwareSshPasswords(root).resolve(credentialRefId)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  expect(await fs.readdir(root)).toEqual([]);
});

it("reuses a staged reference for the same password and rejects another value without revealing either", async () => {
  const { root, passwords } = await fixture();
  const credentialRefId = reference();
  await passwords.save(credentialRefId, "first-private-password");
  expect(await passwords.save(credentialRefId, "first-private-password")).toEqual({ credentialRefId });
  await expect(passwords.save(credentialRefId, "different-private-password")).rejects.toMatchObject({
    code: "CREDENTIAL_CONFLICT", message: "The SSH password reference already holds a different password."
  });
  expect(await passwords.resolve(credentialRefId)).toBe("first-private-password");
  expect(await fs.readdir(root)).toEqual([]);
});

it("keeps the first password when conflicting saves arrive concurrently", async () => {
  const { passwords } = await fixture();
  const credentialRefId = reference();
  const results = await Promise.allSettled([
    passwords.save(credentialRefId, "first"), passwords.save(credentialRefId, "second"), passwords.save(credentialRefId, "first")
  ]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect(await passwords.resolve(credentialRefId)).toBe("first");
});

it("does not share staged credentials between instances using the same directory", async () => {
  const { root, passwords } = await fixture();
  const second = new HardwareSshPasswords(root);
  const credentialRefId = reference();
  await passwords.save(credentialRefId, "first-private-password");
  await expect(second.resolve(credentialRefId)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  await second.save(credentialRefId, "second-private-password");
  expect(await passwords.resolve(credentialRefId)).toBe("first-private-password");
  expect(await second.resolve(credentialRefId)).toBe("second-private-password");
  expect(await fs.readdir(root)).toEqual([]);
});

it("expires a key setup password after fifteen minutes without renewing it on a repeated write", async () => {
  const { root, passwords } = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
  const credentialRefId = reference();
  await passwords.save(credentialRefId, "one-time-password");
  vi.setSystemTime(15 * 60_000 - 1);
  expect(await passwords.resolve(credentialRefId)).toBe("one-time-password");
  await passwords.save(credentialRefId, "one-time-password");
  vi.setSystemTime(15 * 60_000);
  await expect(passwords.resolve(credentialRefId)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  expect(await fs.readdir(root)).toEqual([]);
});

it("limits pending key setup passwords to 256 and frees expired capacity before accepting another", async () => {
  const { root, passwords } = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(0);
  const ids = Array.from({ length: 256 }, () => reference());
  await Promise.all(ids.map(id => passwords.save(id, "pending-password")));
  expect(await passwords.save(ids[0]!, "pending-password")).toEqual({ credentialRefId: ids[0] });
  const next = reference();
  await expect(passwords.save(next, "next-private-password")).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  expect(await passwords.resolve(ids[0]!)).toBe("pending-password");
  vi.setSystemTime(15 * 60_000);
  expect(await passwords.save(next, "next-private-password")).toEqual({ credentialRefId: next });
  await expect(passwords.resolve(ids[0]!)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  expect(await passwords.resolve(next)).toBe("next-private-password");
  expect(await fs.readdir(root)).toEqual([]);
});

it("rejects invalid references and invalid passwords without creating files", async () => {
  const { root, passwords } = await fixture();
  for (const invalid of ["", "../outside", "ssh-registration-invalid", "other-" + randomUUID()]) {
    await expect(passwords.save(invalid, "private-password")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(passwords.resolve(invalid)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(passwords.discardRegistration(invalid)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  }
  for (const password of ["", "line\nbreak", "line\rbreak", "null\0byte", "x".repeat(1024), "é".repeat(512), "\ud800", null, 42])
    await expect(passwords.save(reference(), password)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  const maximum = "é".repeat(511) + "x";
  const credentialRefId = reference();
  await passwords.save(credentialRefId, maximum);
  expect(await passwords.resolve(credentialRefId)).toBe(maximum);
  expect(await fs.readdir(root)).toEqual([]);
});

it("rejects new durable SSH password writes and leaves an existing legacy password unchanged", async () => {
  const { root, passwords, secrets } = await fixture();
  const credentialRefId = reference("password");
  await expect(passwords.save(credentialRefId, "new-private-password")).rejects.toMatchObject({
    code: "INVALID_INPUT", message: "Saving an SSH login password is disabled. Use SSH key setup."
  });
  expect(await fs.readdir(root)).toEqual([]);
  await secrets.update(legacyPasswords({ [credentialRefId]: "existing-private-password" }));
  const before = await fs.readFile(secrets.filePath);
  for (const password of ["existing-private-password", "replacement-private-password"])
    await expect(passwords.save(credentialRefId, password)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(await fs.readFile(secrets.filePath)).toEqual(before);
  expect(await passwords.resolve(credentialRefId)).toBe("existing-private-password");
});

it("reads existing saved SSH passwords after restart through the private legacy store", async () => {
  const { root, secrets } = await fixture();
  const credentialRefId = reference("password");
  await secrets.update(legacyPasswords({ [credentialRefId]: "legacy-login-password" }));
  expect(await new HardwareSshPasswords(root).resolve(credentialRefId)).toBe("legacy-login-password");
  expect((await fs.stat(path.dirname(secrets.filePath))).mode & 0o777).toBe(0o700);
  expect((await fs.stat(secrets.filePath)).mode & 0o777).toBe(0o600);
});

it("never resolves interrupted on-disk registration credentials or writes over them", async () => {
  const { root, passwords, secrets } = await fixture();
  const credentialRefId = reference();
  await secrets.update(legacyPasswords({ [credentialRefId]: "old-disk-password" }));
  const before = await fs.readFile(secrets.filePath);
  await expect(passwords.resolve(credentialRefId)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  await passwords.save(credentialRefId, "new-memory-password");
  expect(await passwords.resolve(credentialRefId)).toBe("new-memory-password");
  expect(await fs.readFile(secrets.filePath)).toEqual(before);
  await expect(new HardwareSshPasswords(root).resolve(credentialRefId)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
});

it("discards a registration password from memory and old disk storage while preserving other credentials", async () => {
  const { passwords, secrets } = await fixture();
  const persistent = reference("password"), registration = reference(), other = reference();
  await secrets.update({ global: { api: "global-private" }, plugins: {
    hardware: { [persistent]: "legacy-login", [registration]: "old-registration", [other]: "other-registration", unrelated: "hardware-private" },
    another: { api: "plugin-private" }
  } });
  await passwords.save(registration, "memory-registration");
  await passwords.discardRegistration(registration);
  await passwords.discardRegistration(persistent);
  await expect(passwords.resolve(registration)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  expect(JSON.parse(await fs.readFile(secrets.filePath, "utf8"))).toEqual({ global: { api: "global-private" }, plugins: {
    hardware: { [persistent]: "legacy-login", [other]: "other-registration", unrelated: "hardware-private" }, another: { api: "plugin-private" }
  } });
});

it("does not create a secret file when discarding an in-memory password or a missing legacy password", async () => {
  const { root, passwords } = await fixture();
  const registration = reference();
  await passwords.save(registration, "one-time-password");
  await passwords.discardRegistration(registration);
  await passwords.discardRegistration(registration);
  await passwords.discardSavedPassword(reference("password"));
  await passwords.clearRegistrationPasswords();
  await expect(passwords.resolve(registration)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  expect(await fs.readdir(root)).toEqual([]);
});

it("clears interrupted registration passwords at startup while preserving legacy and unrelated secrets", async () => {
  const { root, passwords, secrets } = await fixture();
  const persistent = reference("password"), interrupted = [reference(), reference()], staged = reference();
  await secrets.update({ global: { api: "global-private" }, plugins: {
    hardware: { [persistent]: "saved-login", ...Object.fromEntries(interrupted.map(id => [id, "interrupted-password"])), "ssh-registration-unrelated": "hardware-private" },
    another: { api: "plugin-private" }
  } });
  await passwords.save(staged, "memory-password");
  await passwords.clearRegistrationPasswords();
  for (const id of [...interrupted, staged]) await expect(passwords.resolve(id)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  const restarted = new HardwareSshPasswords(root);
  expect(await restarted.resolve(persistent)).toBe("saved-login");
  expect(JSON.parse(await fs.readFile(secrets.filePath, "utf8"))).toEqual({ global: { api: "global-private" }, plugins: {
    hardware: { [persistent]: "saved-login", "ssh-registration-unrelated": "hardware-private" }, another: { api: "plugin-private" }
  } });
});

it("retires only an exact legacy SSH password reference and preserves every other secret", async () => {
  const { passwords, secrets } = await fixture();
  const retired = reference("password"), retained = reference("password"), registration = reference();
  await secrets.update({ global: { api: "global-private" }, plugins: {
    hardware: { [retired]: "retired-login", [retained]: "retained-login", [registration]: "old-registration" }, another: { api: "plugin-private" }
  } });
  for (const invalid of [registration, "ssh-password-invalid", "../outside", "api"])
    await expect(passwords.discardSavedPassword(invalid)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  await passwords.discardSavedPassword(retired);
  await passwords.discardSavedPassword(retired);
  await expect(passwords.resolve(retired)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  expect(await passwords.resolve(retained)).toBe("retained-login");
  expect(JSON.parse(await fs.readFile(secrets.filePath, "utf8"))).toEqual({ global: { api: "global-private" }, plugins: {
    hardware: { [retained]: "retained-login", [registration]: "old-registration" }, another: { api: "plugin-private" }
  } });
});

it("serializes concurrent legacy cleanup without dropping unrelated changes", async () => {
  const { passwords, secrets } = await fixture();
  const retired = reference("password"), retained = reference("password"), registration = reference();
  await secrets.update(legacyPasswords({ [retired]: "retired-login", [retained]: "retained-login", [registration]: "old-registration" }));
  await Promise.all([passwords.clearRegistrationPasswords(), passwords.discardSavedPassword(retired), secrets.update({ global: { api: "concurrent-global" }, plugins: {} })]);
  expect(JSON.parse(await fs.readFile(secrets.filePath, "utf8"))).toEqual({ global: { api: "concurrent-global" }, plugins: { hardware: { [retained]: "retained-login" } } });
});

it("resolves staged, legacy, and startup credentials only from their own namespaces", async () => {
  const { passwords, secrets } = await fixture();
  const legacy = reference("password"), registration = reference();
  await secrets.update(legacyPasswords({ [legacy]: "legacy-password" }));
  await passwords.save(registration, "staged-password");
  const resolve = hardwareCredentialResolver({ CLOUDX_HARDWARE_CREDENTIAL_LAB_TOKEN: "environment-token" }, passwords);
  expect(await resolve(legacy)).toBe("legacy-password");
  expect(await resolve(registration)).toBe("staged-password");
  expect(await resolve("lab-token")).toBe("environment-token");
  for (const id of [legacy, registration])
    await expect(hardwareCredentialResolver({})(id)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
});

it("reports private legacy store failures without including secret text and keeps memory staging independent", async () => {
  const { passwords, secrets } = await fixture();
  const credentialRefId = reference("password");
  await secrets.update(legacyPasswords({ [credentialRefId]: "private-password-marker" }));
  await fs.writeFile(secrets.filePath, '{ "private-password-marker": BROKEN }');
  await expect(passwords.resolve(credentialRefId)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE", message: "The SSH password store could not be read." });
  await expect(passwords.discardSavedPassword(credentialRefId)).rejects.toMatchObject({ code: "STORE_UNAVAILABLE", message: "The saved SSH password could not be discarded." });
  await expect(passwords.clearRegistrationPasswords()).rejects.toMatchObject({ code: "STORE_UNAVAILABLE", message: "Interrupted SSH registration passwords could not be discarded." });
  const registration = reference();
  await passwords.save(registration, "memory-private-password");
  expect(await passwords.resolve(registration)).toBe("memory-private-password");
  await expect(passwords.discardRegistration(registration)).rejects.toMatchObject({ code: "STORE_UNAVAILABLE", message: "The registration password could not be discarded." });
  await expect(passwords.resolve(registration)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
});

it.each(["directory", "file"])("refuses a symlinked legacy secret %s without reading or changing its target", async kind => {
  const { root, passwords } = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-password-outside-"));
  directories.push(outside);
  const persistent = reference("password"), registration = reference();
  const target = path.join(outside, "config-secrets.json");
  const original = JSON.stringify(legacyPasswords({ [persistent]: "outside-private-login", [registration]: "outside-private-registration" }));
  await fs.writeFile(target, original);
  if (kind === "directory") await fs.symlink(outside, path.join(root, "secrets"));
  else { await fs.mkdir(path.join(root, "secrets")); await fs.symlink(target, path.join(root, "secrets/config-secrets.json")); }
  await expect(passwords.resolve(persistent)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  await expect(passwords.discardSavedPassword(persistent)).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  await expect(passwords.clearRegistrationPasswords()).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  await passwords.save(registration, "memory-private-registration");
  expect(await passwords.resolve(registration)).toBe("memory-private-registration");
  await expect(passwords.discardRegistration(registration)).rejects.toMatchObject({ code: "STORE_UNAVAILABLE" });
  await expect(passwords.resolve(registration)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  expect(await fs.readFile(target, "utf8")).toBe(original);
});

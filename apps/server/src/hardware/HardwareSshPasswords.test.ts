import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { HardwareSshPasswords } from "./HardwareSshPasswords.js";
import { hardwareCredentialResolver } from "./hardwareCredentials.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });
const reference = (kind = "password") => `ssh-${kind}-${randomUUID()}`;
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-passwords-"));
  directories.push(root);
  return { root, passwords: new HardwareSshPasswords(root) };
}

it("saves a write-only SSH password privately and resolves it after restart", async () => {
  const { root, passwords } = await fixture();
  const credentialRefId = reference();
  const password = '  secret $`" \\ tab\t🌍  ';
  expect(await passwords.save(credentialRefId, password)).toEqual({ credentialRefId });
  expect(await new HardwareSshPasswords(root).resolve(credentialRefId)).toBe(password);
  expect((await fs.stat(path.join(root, "secrets"))).mode & 0o777).toBe(0o700);
  expect((await fs.stat(path.join(root, "secrets/config-secrets.json"))).mode & 0o777).toBe(0o600);
  expect(await fs.readdir(root)).toEqual(["secrets"]);
});

it("reuses an immutable reference for the same password and rejects a different value", async () => {
  const { root, passwords } = await fixture();
  const credentialRefId = reference();
  await passwords.save(credentialRefId, "first-password");
  const file = path.join(root, "secrets/config-secrets.json");
  const before = await fs.readFile(file);
  expect(await passwords.save(credentialRefId, "first-password")).toEqual({ credentialRefId });
  await expect(passwords.save(credentialRefId, "different-password")).rejects.toMatchObject({ code: "CREDENTIAL_CONFLICT" });
  expect(await fs.readFile(file)).toEqual(before);
  expect(await passwords.resolve(credentialRefId)).toBe("first-password");
});

it("serializes conflicting concurrent saves without changing the first credential", async () => {
  const { passwords } = await fixture();
  const credentialRefId = reference();
  const results = await Promise.allSettled([passwords.save(credentialRefId, "first"), passwords.save(credentialRefId, "second")]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(await passwords.resolve(credentialRefId)).toBe("first");
});

it("keeps a password reference immutable across two stores for the same data directory", async () => {
  const { root, passwords } = await fixture();
  const second = new HardwareSshPasswords(root);
  const credentialRefId = reference();
  const results = await Promise.allSettled([passwords.save(credentialRefId, "first"), second.save(credentialRefId, "second")]);
  expect(results.map(result => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(await second.resolve(credentialRefId)).toBe("first");
});

it("rejects invalid references and passwords before creating secret files", async () => {
  const { root, passwords } = await fixture();
  for (const invalid of ["", "../outside", "ssh-password-invalid", "other-" + randomUUID()])
    await expect(passwords.save(invalid, "a-password")).rejects.toMatchObject({ code: "INVALID_INPUT" });
  for (const password of ["", "line\nbreak", "line\rbreak", "null\0byte", "x".repeat(1024), "é".repeat(512), "\ud800", null, 42])
    await expect(passwords.save(reference(), password)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  expect(await fs.readdir(root)).toEqual([]);
  const maximum = "é".repeat(511) + "x";
  const credentialRefId = reference();
  await passwords.save(credentialRefId, maximum);
  expect(await passwords.resolve(credentialRefId)).toBe(maximum);
});

it("discards a registration password without deleting persistent login credentials", async () => {
  const { passwords } = await fixture();
  const persistent = reference();
  const registration = reference("registration");
  await passwords.save(persistent, "login-password");
  await passwords.save(registration, "registration-password");
  await passwords.discardRegistration(registration);
  await passwords.discardRegistration(persistent);
  expect(await passwords.resolve(persistent)).toBe("login-password");
  await expect(passwords.resolve(registration)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
});

it("resolves saved SSH passwords separately from the startup credential namespace", async () => {
  const { passwords } = await fixture();
  const credentialRefId = reference();
  await passwords.save(credentialRefId, "saved-password");
  const resolve = hardwareCredentialResolver({ CLOUDX_HARDWARE_CREDENTIAL_LAB_TOKEN: "environment-token" }, passwords);
  expect(await resolve(credentialRefId)).toBe("saved-password");
  expect(await resolve("lab-token")).toBe("environment-token");
  await expect(hardwareCredentialResolver({})(credentialRefId)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
});

it("clears interrupted registration passwords at startup and preserves saved logins", async () => {
  const { root, passwords } = await fixture();
  const persistent = reference();
  const interrupted = [reference("registration"), reference("registration")];
  await passwords.save(persistent, "saved-login");
  for (const id of interrupted) await passwords.save(id, "one-time-password");
  const restarted = new HardwareSshPasswords(root);
  await restarted.clearRegistrationPasswords();
  expect(await restarted.resolve(persistent)).toBe("saved-login");
  for (const id of interrupted) await expect(restarted.resolve(id)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
});

it("reports storage failures without including stored secret text", async () => {
  const { root, passwords } = await fixture();
  const credentialRefId = reference();
  await passwords.save(credentialRefId, "private-password-marker");
  await fs.writeFile(path.join(root, "secrets/config-secrets.json"), '{ "private-password-marker": BROKEN }');
  await expect(passwords.resolve(credentialRefId)).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE", message: "The SSH password store could not be read." });
});

it("refuses a symlinked secret directory without reading or changing its target", async () => {
  const { root, passwords } = await fixture();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hardware-password-outside-"));
  directories.push(outside);
  const target = path.join(outside, "config-secrets.json");
  await fs.writeFile(target, '{"marker":"outside"}');
  await fs.symlink(outside, path.join(root, "secrets"));
  await expect(passwords.save(reference(), "private-password-marker")).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  expect(await fs.readFile(target, "utf8")).toBe('{"marker":"outside"}');
});

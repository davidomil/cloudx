import { expect, it } from "vitest";
import { hardwareCredentialResolver } from "./hardwareCredentials.js";
import { buildToolEnv } from "../terminal/ShellLaunch.js";

it("resolves only explicitly configured Hardware references from the startup snapshot", async () => {
  const env = { CLOUDX_HARDWARE_CREDENTIAL_LAB_TOKEN: "secret-one", LAB_TOKEN: "unrelated-secret", PATH: "/usr/bin" };
  const resolve = hardwareCredentialResolver(env);
  expect(await resolve("lab-token")).toBe("secret-one");
  env.CLOUDX_HARDWARE_CREDENTIAL_LAB_TOKEN = "secret-two";
  expect(await resolve("lab-token")).toBe("secret-one");
  await expect(resolve("PATH")).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  await expect(resolve("missing")).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
  await expect(resolve("../outside")).rejects.toThrow("unsupported");
});

it("rejects values that cannot be passed as bounded environment data", async () => {
  for (const value of ["", "contains\0nul", "x".repeat(65_537)]) await expect(hardwareCredentialResolver({ CLOUDX_HARDWARE_CREDENTIAL_TOKEN: value })("token")).rejects.toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
});

it("does not expose the Hardware credential namespace to AI tool launches", () => {
  const env = buildToolEnv({ PATH: "/usr/bin", CLOUDX_HARDWARE_CREDENTIAL_LAB_TOKEN: "private", CLOUDX_HARDWARE_CONTEXT: "/private/execution.json" });
  expect(env.CLOUDX_HARDWARE_CREDENTIAL_LAB_TOKEN).toBeUndefined();
  expect(env.CLOUDX_HARDWARE_CONTEXT).toBe("/private/execution.json");
});

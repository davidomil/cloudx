import { hardwareId } from "@cloudx/shared";
import { HardwareError } from "./HardwareError.js";
import type { HardwareSshPasswords } from "./HardwareSshPasswords.js";

export const HARDWARE_CREDENTIAL_PREFIX = "CLOUDX_HARDWARE_CREDENTIAL_";

/** Capture only the dedicated host namespace; scripts receive only their selected references. */
export function hardwareCredentialResolver(env: NodeJS.ProcessEnv = process.env, sshPasswords?: Pick<HardwareSshPasswords, "resolve">): (id: string) => Promise<string> {
  const values = new Map(Object.entries(env).flatMap(([name, value]) => name.startsWith(HARDWARE_CREDENTIAL_PREFIX) && value !== undefined ? [[name, value] as const] : []));
  return async id => {
    hardwareId(id, "Credential reference");
    if (/^ssh-(?:password|registration)-/.test(id)) {
      if (!sshPasswords) throw new HardwareError("CREDENTIAL_UNAVAILABLE", "The saved SSH password store is unavailable.");
      return sshPasswords.resolve(id);
    }
    const value = values.get(`${HARDWARE_CREDENTIAL_PREFIX}${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`);
    if (!value || value.includes("\0") || Buffer.byteLength(value) > 64 * 1024) throw new HardwareError("CREDENTIAL_UNAVAILABLE", "The configured Hardware credential reference is unavailable.");
    return value;
  };
}

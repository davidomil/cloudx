import { ConfigSecretStore } from "../configSecretStore.js";
import { HardwareError, requireHardware } from "./HardwareError.js";

const referencePattern = /^ssh-(?:password|registration)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const registrationLifetimeMs = 15 * 60_000;
const registrationCapacity = 256;

/** New passwords live only for key setup. Existing login passwords remain readable until replaced. */
export class HardwareSshPasswords {
  private readonly registrations = new Map<string, { password: string; expiresAt: number }>();
  private legacyWrites = Promise.resolve();
  private readonly secrets: ConfigSecretStore;

  constructor(dataDir: string) { this.secrets = new ConfigSecretStore(dataDir); }

  async save(credentialRefId: string, password: unknown): Promise<{ credentialRefId: string }> {
    validateReference(credentialRefId);
    requireHardware(credentialRefId.startsWith("ssh-registration-"), "INVALID_INPUT", "Saving an SSH login password is disabled. Use SSH key setup.");
    requireHardware(validPassword(password), "INVALID_INPUT", "Enter a single-line SSH password of 1 to 1023 UTF-8 bytes.");
    this.discardExpired();
    const current = this.registrations.get(credentialRefId);
    if (current) {
      requireHardware(current.password === password, "CREDENTIAL_CONFLICT", "The SSH password reference already holds a different password.");
    } else {
      requireHardware(this.registrations.size < registrationCapacity, "SERVICE_UNAVAILABLE", "Too many SSH key setups are pending. Finish a key setup or wait for its password to expire.");
      this.registrations.set(credentialRefId, { password, expiresAt: Date.now() + registrationLifetimeMs });
    }
    return { credentialRefId };
  }

  async resolve(credentialRefId: string): Promise<string> {
    validateReference(credentialRefId);
    this.discardExpired();
    if (credentialRefId.startsWith("ssh-registration-")) {
      const registration = this.registrations.get(credentialRefId);
      requireHardware(registration, "CREDENTIAL_UNAVAILABLE", "The SSH key setup password is unavailable. Enter it again.");
      return registration.password;
    }
    await this.legacyWrites;
    const value = this.read(credentialRefId);
    requireHardware(validPassword(value), "CREDENTIAL_UNAVAILABLE", "The saved SSH password is unavailable.");
    return value;
  }

  async discardRegistration(credentialRefId: string): Promise<void> {
    validateReference(credentialRefId);
    if (!credentialRefId.startsWith("ssh-registration-")) return;
    this.registrations.delete(credentialRefId);
    await this.discardStored(credentialRefId, "The registration password could not be discarded.");
  }

  /** The caller must first save key authentication and confirm that no item or reservation uses this reference. */
  async discardSavedPassword(credentialRefId: string): Promise<void> {
    validateReference(credentialRefId);
    requireHardware(credentialRefId.startsWith("ssh-password-"), "INVALID_INPUT", "Choose a saved SSH password reference.");
    await this.discardStored(credentialRefId, "The saved SSH password could not be discarded.");
  }

  /** Call after acquiring Hardware's writer lease, before admitting requests. */
  async clearRegistrationPasswords(): Promise<void> {
    this.registrations.clear();
    await this.change(async () => {
      try {
        for (const id of this.secrets.getPluginSecretKeys("hardware"))
          if (referencePattern.test(id) && id.startsWith("ssh-registration-")) await this.secrets.deletePluginSecret("hardware", id);
      } catch { throw new HardwareError("STORE_UNAVAILABLE", "Interrupted SSH registration passwords could not be discarded."); }
    });
  }

  private discardExpired(): void {
    const now = Date.now();
    for (const [id, value] of this.registrations) if (value.expiresAt <= now) this.registrations.delete(id);
  }

  private discardStored(credentialRefId: string, message: string): Promise<void> {
    return this.change(async () => {
      try {
        if (this.secrets.getPluginSecret("hardware", credentialRefId) !== undefined)
          await this.secrets.deletePluginSecret("hardware", credentialRefId);
      } catch { throw new HardwareError("STORE_UNAVAILABLE", message); }
    });
  }

  private read(credentialRefId: string): string | undefined {
    try { return this.secrets.getPluginSecret("hardware", credentialRefId); }
    catch { throw new HardwareError("CREDENTIAL_UNAVAILABLE", "The SSH password store could not be read."); }
  }

  private change<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.legacyWrites.then(operation);
    this.legacyWrites = result.then(() => undefined, () => undefined);
    return result;
  }
}

function validateReference(value: string): void {
  requireHardware(typeof value === "string" && referencePattern.test(value), "INVALID_INPUT", "Choose a valid SSH password reference.");
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000\r\n]/.test(value) && Buffer.byteLength(value) <= 1023 && Buffer.from(value).toString("utf8") === value;
}

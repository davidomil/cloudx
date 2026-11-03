import { ConfigSecretStore } from "../configSecretStore.js";
import { HardwareError, requireHardware } from "./HardwareError.js";

const referencePattern = /^ssh-(?:password|registration)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Inventory stores only references. Password values stay in the private config secret store. */
export class HardwareSshPasswords {
  private static readonly writeQueues = new Map<string, Promise<void>>();
  private readonly secrets: ConfigSecretStore;

  constructor(dataDir: string) { this.secrets = new ConfigSecretStore(dataDir); }

  async save(credentialRefId: string, password: unknown): Promise<{ credentialRefId: string }> {
    validateReference(credentialRefId);
    requireHardware(validPassword(password), "INVALID_INPUT", "Enter a single-line SSH password of 1 to 1023 UTF-8 bytes.");
    return this.change(async () => {
      const current = this.read(credentialRefId);
      if (current !== undefined) {
        requireHardware(current === password, "CREDENTIAL_CONFLICT", "The SSH password reference already holds a different password.");
      } else {
        try { await this.secrets.update({ global: {}, plugins: { hardware: { [credentialRefId]: password } } }); }
        catch { throw new HardwareError("STORE_UNAVAILABLE", "The SSH password could not be saved."); }
      }
      return { credentialRefId };
    });
  }

  async resolve(credentialRefId: string): Promise<string> {
    validateReference(credentialRefId);
    await this.writeQueue();
    const value = this.read(credentialRefId);
    requireHardware(validPassword(value), "CREDENTIAL_UNAVAILABLE", "The saved SSH password is unavailable.");
    return value;
  }

  async discardRegistration(credentialRefId: string): Promise<void> {
    validateReference(credentialRefId);
    if (!credentialRefId.startsWith("ssh-registration-")) return;
    await this.change(async () => {
      try { await this.secrets.deletePluginSecret("hardware", credentialRefId); }
      catch { throw new HardwareError("STORE_UNAVAILABLE", "The registration password could not be discarded."); }
    });
  }

  /** Call after acquiring Hardware's writer lease, before admitting requests. */
  async clearRegistrationPasswords(): Promise<void> {
    await this.change(async () => {
      try {
        for (const id of this.secrets.getPluginSecretKeys("hardware"))
          if (referencePattern.test(id) && id.startsWith("ssh-registration-")) await this.secrets.deletePluginSecret("hardware", id);
      } catch { throw new HardwareError("STORE_UNAVAILABLE", "Interrupted SSH registration passwords could not be discarded."); }
    });
  }

  private read(credentialRefId: string): string | undefined {
    try { return this.secrets.getPluginSecret("hardware", credentialRefId); }
    catch { throw new HardwareError("CREDENTIAL_UNAVAILABLE", "The SSH password store could not be read."); }
  }

  private change<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writeQueue().then(operation);
    HardwareSshPasswords.writeQueues.set(this.secrets.filePath, result.then(() => undefined, () => undefined));
    return result;
  }

  private writeQueue(): Promise<void> {
    return HardwareSshPasswords.writeQueues.get(this.secrets.filePath) ?? Promise.resolve();
  }
}

function validateReference(value: string): void {
  requireHardware(typeof value === "string" && referencePattern.test(value), "INVALID_INPUT", "Choose a valid SSH password reference.");
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !/[\u0000\r\n]/.test(value) && Buffer.byteLength(value) <= 1023 && Buffer.from(value).toString("utf8") === value;
}

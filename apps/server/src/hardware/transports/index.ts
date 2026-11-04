import type { HardwareTypeProvider } from "@cloudx/plugin-api";
import type { PathPolicy } from "../../pathPolicy.js";
import { SshHardwareProvider } from "./SshHardwareProvider.js";
import { UartHardwareProvider } from "./UartHardwareProvider.js";

export { SshHardwareProvider, sshHardwareDescriptor } from "./SshHardwareProvider.js";
export { UartHardwareProvider, uartHardwareDescriptor } from "./UartHardwareProvider.js";

export function createHardwareProviders(options: { pathPolicy: Pick<PathPolicy, "resolve" | "isAllowed"> }): HardwareTypeProvider<unknown>[] {
  return [new SshHardwareProvider(options), new UartHardwareProvider(options)];
}

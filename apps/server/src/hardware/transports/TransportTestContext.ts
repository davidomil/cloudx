import type { HardwareAccessContext } from "@cloudx/plugin-api";

export function transportTestContext(signal = new AbortController().signal): HardwareAccessContext & { cleanups: Parameters<HardwareAccessContext["registerCleanup"]>[0][] } {
  const cleanups: Parameters<HardwareAccessContext["registerCleanup"]>[0][] = [];
  return {
    reservation: { reservationId: "reservation", generation: 1, revision: 1, hardwareId: "device", owner: { kind: "user", userId: "local" }, state: "active", resourceKeys: [], purpose: "Transport emulation", acquiredItemRevision: 1, acquiredNotesRevision: 1, acquiredAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastOwnerObservation: "active", activeOperationIds: [] },
    signal, cleanups,
    resolveCredential: async () => { throw new Error("No emulation credentials are configured."); },
    recordEvent: async () => {}, registerCleanup: (close) => cleanups.push(close)
  };
}

import type {
  HardwareFilter,
  HardwareOwner,
  HardwareSummary,
  StatusBinding,
  StatusDefinition,
  WorkspaceTab,
} from "@cloudx/shared";

export function ownerLabel(
  owner: HardwareOwner,
  tabs?: Pick<WorkspaceTab, "id" | "title">[],
): string {
  return owner.kind === "user"
    ? "You"
    : `${owner.providerId === "codex" ? "Codex" : "Claude"} · ${tabs?.find((tab) => tab.id === owner.tabId)?.title ?? (owner.workerId ? `worker ${owner.workerId} · attempt ${owner.attemptId}` : owner.tabId)}`;
}

export function sameOwner(left: HardwareOwner, right: HardwareOwner): boolean {
  if (left.kind === "user" || right.kind === "user")
    return (
      left.kind === "user" &&
      right.kind === "user" &&
      left.userId === right.userId
    );
  return (
    [
      "tabId",
      "providerId",
      "executionId",
      "ownerPluginId",
      "logicalRunId",
      "workerId",
      "attemptId",
    ] as const
  ).every((key) => left[key] === right[key]);
}

export function matchesHardware(
  summary: HardwareSummary,
  filter: HardwareFilter,
  owner: HardwareOwner,
): boolean {
  const { item } = summary;
  const text = filter.text?.toLocaleLowerCase();
  if (
    text &&
    !`${item.name}\n${item.description}\n${item.notes}`
      .toLocaleLowerCase()
      .includes(text)
  )
    return false;
  if (filter.typeIds?.length && !filter.typeIds.includes(item.typeId))
    return false;
  if (
    filter.tags?.all?.some((tag) => !item.tagIds.includes(tag)) ||
    filter.tags?.none?.some((tag) => item.tagIds.includes(tag)) ||
    (filter.tags?.any?.length &&
      !filter.tags.any.some((tag) => item.tagIds.includes(tag)))
  )
    return false;
  if (
    (filter.availability && summary.availability !== filter.availability) ||
    (filter.enabled !== undefined && item.enabled !== filter.enabled)
  )
    return false;
  if (
    filter.ownedByMe &&
    (!summary.reservation || !sameOwner(summary.reservation.owner, owner))
  )
    return false;
  return !(filter.statuses ?? []).some((predicate) => {
    const observation = summary.observations.find(
      (value) => value.definitionId === predicate.definitionId,
    );
    return (
      !observation ||
      observation.state !== "known" ||
      observation.value !== predicate.equals ||
      (predicate.requireFresh &&
        Boolean(
          observation.expiresAt &&
          Date.parse(observation.expiresAt) <= Date.now(),
        ))
    );
  });
}

export function newStatusBinding(definition: StatusDefinition): StatusBinding {
  return {
    revision: 1,
    definitionId: definition.id,
    source: "manual",
    value:
      definition.valueType === "boolean"
        ? false
        : (definition.enumValues?.[0] ?? ""),
  };
}

export function uartBytes(
  value: string,
  mode: "text" | "base64",
  ending: string,
): string {
  if (mode === "base64") {
    atob(value);
    return value;
  }
  const bytes = new TextEncoder().encode(
    value + ({ none: "", LF: "\n", CR: "\r", CRLF: "\r\n" }[ending] ?? ""),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function uartText(base64: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
  );
}

import type { AutomationType } from "./index.js";

const UNKNOWN_TYPE: AutomationType = { kind: "unknown" };

export function automationTypeAssignable(source: AutomationType, target: AutomationType): boolean {
  if (target.kind === "unknown" || source.kind === "never") {
    return true;
  }
  if (source.kind === "unknown") {
    return false;
  }
  if (source.kind === "union") {
    return (source.options ?? []).every((option) => automationTypeAssignable(option, target));
  }
  if (target.kind === "union") {
    return (target.options ?? []).some((option) => automationTypeAssignable(source, option));
  }
  if (source.kind !== target.kind) {
    return false;
  }
  if (source.kind === "array" && target.kind === "array") {
    return automationTypeAssignable(source.items ?? UNKNOWN_TYPE, target.items ?? UNKNOWN_TYPE);
  }
  if (source.kind === "object" && target.kind === "object") {
    const sourceProperties = source.properties ?? {};
    const sourceRequired = new Set(source.required ?? []);
    const targetProperties = target.properties ?? {};
    for (const key of target.required ?? []) {
      if (!sourceProperties[key] || !sourceRequired.has(key)) {
        return false;
      }
    }
    return Object.entries(targetProperties).every(([key, targetType]) => {
      const sourceType = sourceProperties[key];
      return !sourceType || automationTypeAssignable(sourceType, targetType);
    });
  }
  return true;
}

import { useId } from "react";
import type { ClaudeLaunchMode } from "@cloudx/shared";

export function claudeLaunchModeLabel(mode: ClaudeLaunchMode): string {
  return mode === "cloudx-managed" ? "CloudX-managed" : "Native project";
}

export function ClaudeLaunchModeControl({ value, inheritedLabel, onChange }: {
  value: ClaudeLaunchMode | "";
  inheritedLabel: string;
  onChange: (value: ClaudeLaunchMode | "") => void;
}) {
  const disclosureId = useId();
  return <div className="claude-launch-mode">
    <div id={disclosureId}>
      <p><strong>CloudX-managed is opt-in.</strong> Shared project settings, project CLAUDE.md and project rules are omitted. The supported configuration also omits local settings and CLAUDE.local.md; existing local inputs block launch with an actionable diagnostic. Use Native project to retain them. Permitted personal inputs remain. CloudX system/template skills and selected external skills form the controlled available set in the verified Claude Code 2.1.316 configuration on Linux.</p>
      <p><strong>Native project</strong> preserves native project discovery. CloudX-supplied skill choices are additions, not an exclusive native allowlist. Account isolation, required hooks/receipts and selected CloudX system/template ownership apply in both modes.</p>
    </div>
    <label>
      Claude launch mode
      <select aria-label="Claude launch mode" aria-describedby={disclosureId} value={value} onChange={event => onChange(event.target.value as ClaudeLaunchMode | "")}>
        <option value="">{inheritedLabel}</option>
        <option value="native-project">Native project</option>
        <option value="cloudx-managed">CloudX-managed</option>
      </select>
    </label>
    <small>Mode, skill selection, revocation and source updates apply to the next launch. Open sessions are not restarted. Unsupported native or managed policy combinations fail before work; CloudX does not change mode automatically.</small>
  </div>;
}

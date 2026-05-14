import { describe, expect, it } from "vitest";

import { controlClassName } from "./Control.js";

describe("controlClassName", () => {
  it("builds the base button class", () => {
    expect(controlClassName()).toBe("cx-button cx-button-neutral");
  });

  it("adds tone, size, icon, and state classes", () => {
    expect(controlClassName({ tone: "danger", size: "compact", iconOnly: true, pressed: true, selected: true, className: "extra" })).toBe(
      "cx-button cx-button-danger cx-button-compact cx-button-icon is-pressed is-selected extra"
    );
  });
});

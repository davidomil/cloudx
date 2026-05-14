import { describe, expect, it } from "vitest";

import { isOutsidePointerTarget } from "./outsidePointer.js";

class FakeNode {
  parent: FakeNode | null;
  attributes = new Map<string, string>();
  ownerDocument = { defaultView: { Node: FakeNode, Element: FakeNode } };

  constructor(parent: FakeNode | null = null) {
    this.parent = parent;
  }

  contains(target: FakeNode) {
    let current: FakeNode | null = target;
    while (current) {
      if (current === this) {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  get parentElement() {
    return this.parent;
  }

  closest(selector: string) {
    let current: FakeNode | null = this;
    while (current) {
      if (selector === `[data-outside-pointer-inside="true"]` && current.attributes.get("data-outside-pointer-inside") === "true") {
        return current;
      }
      current = current.parent;
    }
    return null;
  }
}

describe("isOutsidePointerTarget", () => {
  it("reports targets outside the root", () => {
    const root = new FakeNode();
    const inside = new FakeNode(root);
    const outside = new FakeNode();

    expect(isOutsidePointerTarget(root as unknown as HTMLElement, inside as unknown as EventTarget)).toBe(false);
    expect(isOutsidePointerTarget(root as unknown as HTMLElement, root as unknown as EventTarget)).toBe(false);
    expect(isOutsidePointerTarget(root as unknown as HTMLElement, outside as unknown as EventTarget)).toBe(true);
  });

  it("ignores unresolved roots and non-node event targets", () => {
    const root = new FakeNode();

    expect(isOutsidePointerTarget(null, root as unknown as EventTarget)).toBe(false);
    expect(isOutsidePointerTarget(root as unknown as HTMLElement, null)).toBe(false);
    expect(isOutsidePointerTarget(root as unknown as HTMLElement, new EventTarget())).toBe(false);
  });

  it("treats marked floating targets as inside the active surface", () => {
    const root = new FakeNode();
    const floatingLayer = new FakeNode();
    floatingLayer.attributes.set("data-outside-pointer-inside", "true");
    const option = new FakeNode(floatingLayer);

    expect(isOutsidePointerTarget(root as unknown as HTMLElement, option as unknown as EventTarget)).toBe(false);
  });
});

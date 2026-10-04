import { createRoot } from "react-dom/client";
import {
  CloudxUpdatePanel,
  type CloudxUpdateController,
} from "../../../apps/web/src/ui/CloudxUpdatePanel.js";
import "../../../apps/web/src/styles.css";

const checkedAt = "2026-10-04T03:02:05Z";
const update: CloudxUpdateController = {
  status: { available: true },
  preview: {
    channel: "main",
    currentCommit: "a".repeat(40),
    checkedAt,
    state: "available",
    target: {
      commit: "b".repeat(40),
      name: "main",
      url: "https://github.com/davidomil/cloudx",
    },
    runtime: {
      verification: "verified",
      commit: "a".repeat(40),
      builtAt: checkedAt,
      sourceDirty: false,
    },
    changelog: [],
    changelogComplete: true,
  },
  channel: "main",
  previewLoading: false,
  starting: false,
  checking: false,
  reassessing: false,
  start: async () => undefined,
  resume: async () => undefined,
  check: () => undefined,
  reassessCapacity: async () => undefined,
  selectChannel: () => undefined,
};

document.body.style.overflow = "auto";
document.body.style.height = "auto";
const element = document.querySelector<HTMLElement>("#root")!;
element.style.maxWidth = "900px";
element.style.padding = "16px";
createRoot(element).render(<CloudxUpdatePanel update={update} />);

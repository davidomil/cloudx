import { describe, expect, it } from "vitest";
import { isGeneratedForgeLink, isGeneratedForgePath, isTypeScriptBuildInfo } from "./ForgeGeneratedArtifacts.js";

describe("Forge generated artifacts", () => {
  it.each([
    [".cloudx/native/bin/codex", "../lib/node_modules/@openai/codex/bin/codex.js", true],
    [".cloudx/bin/tool", "../dist/tool.js", true],
    [".cloudx/bin/tool", "../../../node_modules/tool.js", false],
    [".cloudx/bin/tool", "/other/node_modules/tool.js", false],
    [".cloudx/bin/tool", "../../.git/node_modules/tool.js", false],
    [".cloudx/bin/tool", "../source/tool.js", false],
    [".cloudx/bin/tool", "..\\node_modules\\tool.js", false],
    [".cloudx/bin/tool", "../node_modules/\0tool.js", false],
  ] as const)("classifies generated link %s → %s without following its target", (relative, target, disposable) => {
    expect(isGeneratedForgeLink(relative, target)).toBe(disposable);
  });

  it("recognizes dependency and build paths without classifying report directories as disposable", () => {
    for (const file of ["node_modules/package/index.js", ".cloudx/project/dist/app.js", "app/tsconfig.tsbuildinfo"])
      expect(isGeneratedForgePath(file)).toBe(true);
    for (const file of [".cloudx/evidence.log", "test-results/reproduction.txt", "src/build-info.ts"])
      expect(isGeneratedForgePath(file)).toBe(false);
  });

  it.each([
    { fileNames: ["./source.ts"], fileInfos: ["content-hash"], root: [1], version: "6.0.3" },
    { fileNames: ["./source.ts"], fileInfos: [{ version: "content-hash", signature: false }], version: "6.0.3" },
    { root: ["./source.ts"], version: "6.0.3" },
  ])("verifies compiler build-info structure %j", info => {
    expect(isTypeScriptBuildInfo(JSON.stringify(info))).toBe(true);
  });

  it.each([
    "Useful handwritten investigation", "null", "[]", "{", '{"version":"6.0.3"}',
    '{"root":["./source.ts"],"version":"human notes"}',
    '{"fileNames":["./source.ts"],"fileInfos":[],"version":"6.0.3"}',
    '{"fileNames":["./source.ts"],"fileInfos":[{}],"version":"6.0.3"}',
    '{"root":[1],"version":"6.0.3"}',
  ])("preserves unknown contents named as build-info: %s", content => {
    expect(isTypeScriptBuildInfo(content)).toBe(false);
  });
});

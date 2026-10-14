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

  it.each(["plugins", "plugins-clone-QkqfBY"])("recognizes the native Codex %s cache without discarding its useful fixture siblings", cache => {
    const home = "evidence/settings-profile/data/codex-launches/model-scope";
    for (const generated of [`${home}/.tmp/${cache}`, `${home}/.tmp/${cache}/plugins/creative-production/mcp/server.bundle.mjs`])
      expect(isGeneratedForgePath(generated)).toBe(true);
    for (const valuable of [
      `${home}/config.toml`, `${home}/state_5.sqlite-wal`, `${home}/.tmp/diagnostics.log`,
      `${home}/plugins/fixture/reproduction.ts`, `${home}/.tmp/plugins-clone-`,
      "evidence/repro/.tmp/plugins/source.ts", "evidence/repro/plugins-clone-source/input.json",
    ]) expect(isGeneratedForgePath(valuable)).toBe(false);
  });

  it("recognizes fixture links into native plugin caches without following them", () => {
    expect(isGeneratedForgeLink("evidence/profile/plugin", "data/codex-launches/model/.tmp/plugins/plugins/example")).toBe(true);
    expect(isGeneratedForgeLink("evidence/profile/plugin", "data/codex-launches/model/plugins/example")).toBe(false);
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

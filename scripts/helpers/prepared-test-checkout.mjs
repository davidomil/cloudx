import fs from "node:fs";
import path from "node:path";
import { OwnedTestFixture } from "./owned-test-fixture.mjs";

export class PreparedTestCheckout {
  static async create(sourceRoot, options) {
    const owner = await OwnedTestFixture.create("prepared-current-checkout", options);
    const prepared = new PreparedTestCheckout(owner);
    try {
      await owner.run("clone-current-source", "git", ["clone", "--shared", sourceRoot, prepared.source]);
      await owner.run("detach-current-source", "git", ["checkout", "--detach", "HEAD"], { cwd: prepared.source });
      await owner.run("install-current-dependencies", "npm", ["ci", "--no-audit", "--no-fund"], { cwd: prepared.source, timeout: 120_000 });
      await owner.run("build-current-source", "npm", ["run", "build"], { cwd: prepared.source, timeout: 120_000 });
      return prepared;
    } catch (error) {
      await owner.close("failed");
      throw error;
    }
  }

  constructor(owner) {
    this.owner = owner;
    this.source = path.join(owner.root, "checkout");
  }

  async copyTo(destination) {
    if (this.owner.closing) throw new Error("Prepared checkout is closed; new copies are forbidden.");
    fs.mkdirSync(destination);
    await this.owner.run("copy-prepared-checkout", "cp", ["-a", `${this.source}/.`, destination]);
    await this.owner.run("refresh-copied-index", "git", ["update-index", "--refresh"], { cwd: destination });
  }

  close() { return this.owner.close("passed"); }
}

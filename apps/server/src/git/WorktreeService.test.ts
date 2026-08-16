import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, vi } from "vitest";

import type { WorktreeProjectState } from "@cloudx/shared";

import { PathPolicy } from "../pathPolicy.js";
import { WorktreeService } from "./WorktreeService.js";

const execFileAsync = promisify(execFile);

describe("WorktreeService", () => {
  it("rejects every public operation outside configured roots before Git or filesystem mutation", async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-policy-allowed-"));
    const outsideProject = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-policy-outside-"));
    const marker = path.join(allowedRoot, "git-started");
    const executable = await markingGitExecutable(allowedRoot, marker);
    const service = new WorktreeService(new PathPolicy([allowedRoot]), executable);
    const before = await fs.readdir(outsideProject);
    const operations = [
      () => service.getState(outsideProject),
      () => service.initializeBareRepository(outsideProject),
      () => service.cloneBareRepository(outsideProject, "https://example.test/repo.git"),
      () => service.fetchRefs(outsideProject),
      () => service.createWorktree(outsideProject, createInput("feature", "feature", "HEAD")),
      () => service.deleteWorktree(outsideProject, { folderName: "feature", confirmation: "feature" }),
    ];
    for (const operation of operations) await expect(operation()).rejects.toThrow(/outside configured Cloudx roots/);
    await expect(fs.readdir(outsideProject)).resolves.toEqual(before);
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects initialization when an admitted alias escapes before the first capability use", async () => {
    if (process.platform === "win32") return;
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-policy-retarget-"));
    const project = path.join(allowedRoot, "project");
    const alias = path.join(allowedRoot, "project-alias");
    const outsideProject = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-policy-retarget-outside-"));
    const marker = path.join(allowedRoot, "git-started");
    await fs.mkdir(project);
    await fs.symlink(project, alias, "dir");
    const executable = await markingGitExecutable(allowedRoot, marker);
    const policy = new PathPolicy([allowedRoot]);
    const ensureDirectory = policy.ensureDirectory.bind(policy);
    let admissions = 0;
    vi.spyOn(policy, "ensureDirectory").mockImplementation(async (candidate, createDirectory) => {
      const admitted = await ensureDirectory(candidate, createDirectory);
      if (++admissions === 1) {
        await fs.unlink(alias);
        await fs.symlink(outsideProject, alias, "dir");
      }
      return admitted;
    });
    const service = new WorktreeService(policy, executable);
    await expect(service.initializeBareRepository(alias)).rejects.toThrow(/outside configured Cloudx roots/);
    await expect(fs.readdir(project)).resolves.toEqual([]);
    await expect(fs.readdir(outsideProject)).resolves.toEqual([]);
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an alias retargeted between its two admitted canonical observations", async () => {
    if (process.platform === "win32") return;
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-policy-between-"));
    const firstProject = path.join(allowedRoot, "first-project");
    const secondProject = path.join(allowedRoot, "second-project");
    const alias = path.join(allowedRoot, "project-alias");
    const marker = path.join(allowedRoot, "git-started");
    await fs.mkdir(firstProject);
    await fs.mkdir(secondProject);
    await fs.symlink(firstProject, alias, "dir");
    const executable = await markingGitExecutable(allowedRoot, marker);
    const policy = new PathPolicy([allowedRoot]);
    const ensureDirectory = policy.ensureDirectory.bind(policy);
    let admissions = 0;
    vi.spyOn(policy, "ensureDirectory").mockImplementation(async (candidate, createDirectory) => {
      const admitted = await ensureDirectory(candidate, createDirectory);
      if (++admissions === 2) {
        await fs.unlink(alias);
        await fs.symlink(secondProject, alias, "dir");
      }
      return admitted;
    });

    await expect(
      new WorktreeService(policy, executable).initializeBareRepository(alias),
    ).rejects.toThrow("Directory identity changed while authorizing");
    await expect(fs.readdir(firstProject)).resolves.toEqual([]);
    await expect(fs.readdir(secondProject)).resolves.toEqual([]);
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a same-path replacement between its two directory identity observations", async () => {
    const allowedRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-policy-observation-replace-"),
    );
    const project = path.join(allowedRoot, "project");
    const displaced = path.join(allowedRoot, "displaced-project");
    const marker = path.join(allowedRoot, "git-started");
    await fs.mkdir(project);
    const policy = new PathPolicy([allowedRoot]);
    const ensureDirectory = policy.ensureDirectory.bind(policy);
    let admissions = 0;
    vi.spyOn(policy, "ensureDirectory").mockImplementation(
      async (candidate, createDirectory) => {
        admissions += 1;
        if (admissions === 2) {
          await fs.rename(project, displaced);
          await fs.mkdir(project);
        }
        return ensureDirectory(candidate, createDirectory);
      },
    );

    await expect(
      new WorktreeService(
        policy,
        await markingGitExecutable(allowedRoot, marker),
      ).initializeBareRepository(project),
    ).rejects.toThrow("Directory identity changed while authorizing");
    await expect(fs.readdir(displaced)).resolves.toEqual([]);
    await expect(fs.readdir(project)).resolves.toEqual([]);
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a device-only change between directory identity observations", async () => {
    const allowedRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-policy-device-change-"),
    );
    const project = path.join(allowedRoot, "project");
    await fs.mkdir(project);
    const originalLstat = fs.lstat.bind(fs);
    let observations = 0;
    const lstat = vi
      .spyOn(fs, "lstat")
      .mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        const result = await originalLstat(...args);
        if (String(args[0]) !== project || ++observations !== 2) {
          return result;
        }
        return new Proxy(result, {
          get(target, property, receiver) {
            return property === "dev"
              ? BigInt(target.dev) + 1n
              : Reflect.get(target, property, receiver);
          },
        });
      });
    const service = new WorktreeService(new PathPolicy([allowedRoot]));
    const productionSeam = service as unknown as {
      requireExistingDirectory(candidate: string): Promise<unknown>;
    };

    try {
      await expect(
        productionSeam.requireExistingDirectory(project),
      ).rejects.toThrow("Directory identity changed while authorizing");
    } finally {
      lstat.mockRestore();
    }
  });

  it("preserves a configured symlink-root expression while returning its physical path", async () => {
    if (process.platform === "win32") return;
    const physicalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-physical-root-"));
    const expressionParent = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-root-expression-"));
    const configuredRoot = path.join(expressionParent, "configured-root");
    const project = path.join(physicalRoot, "project");
    await fs.mkdir(project);
    await fs.symlink(physicalRoot, configuredRoot, "dir");
    const policy = new PathPolicy([configuredRoot]);
    const observedExpressions: string[] = [];
    const ensureDirectory = policy.ensureDirectory.bind(policy);
    vi.spyOn(policy, "ensureDirectory").mockImplementation(async (candidate, createDirectory) => {
      observedExpressions.push(candidate);
      return ensureDirectory(candidate, createDirectory);
    });

    await expect(
      new WorktreeService(policy).getState(path.join(configuredRoot, "project")),
    ).resolves.toMatchObject({ status: "empty", cwd: project, projectDir: project });
    expect(observedExpressions).not.toContain(project);
    expect(observedExpressions).toEqual(
      expect.arrayContaining([path.join(configuredRoot, "project")]),
    );
  });

  it("creates once through a configured-only symlink root and returns canonical state", async () => {
    if (process.platform === "win32") return;
    const {
      baseRef,
      mutationLog,
      physicalProject,
      projectExpression,
      service,
    } = await createConfiguredSymlinkRootProject("cloudx-wt-symlink-create-");
    const destination = path.join(physicalProject, "created-through-alias");

    const result = await service
      .createWorktree(
        projectExpression,
        createInput("created-through-alias", "created-through-alias", baseRef),
      )
      .catch((error: unknown) => error);

    expect(await readLines(mutationLog)).toEqual(["add"]);
    await expect(fs.access(destination)).resolves.toBeUndefined();
    await expectWorktreeRegistration(physicalProject, destination);
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toMatchObject({
      status: "ready",
      cwd: physicalProject,
      projectDir: physicalProject,
      barePath: path.join(physicalProject, ".bare"),
      worktrees: [
        expect.objectContaining({
          folderName: "created-through-alias",
          path: destination,
        }),
      ],
    });
  });

  it("deletes once through a configured-only symlink root and returns canonical state", async () => {
    if (process.platform === "win32") return;
    const {
      baseRef,
      mutationLog,
      physicalProject,
      projectExpression,
      service,
    } = await createConfiguredSymlinkRootProject("cloudx-wt-symlink-delete-");
    const destination = path.join(physicalProject, "deleted-through-alias");
    await git(
      physicalProject,
      "--git-dir",
      path.join(physicalProject, ".bare"),
      "worktree",
      "add",
      "-b",
      "deleted-through-alias",
      destination,
      baseRef,
    );
    await expectWorktreeRegistration(physicalProject, destination);

    const result = await service
      .deleteWorktree(projectExpression, {
        folderName: "deleted-through-alias",
        confirmation: "deleted-through-alias",
      })
      .catch((error: unknown) => error);

    expect(await readLines(mutationLog)).toEqual(["remove"]);
    await expect(fs.access(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expectNoWorktreeRegistration(physicalProject, destination);
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toMatchObject({
      status: "ready",
      cwd: physicalProject,
      projectDir: physicalProject,
      barePath: path.join(physicalProject, ".bare"),
      worktrees: [],
    });
  });

  it("rejects a same-path directory replacement before its first capability use", async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-policy-replace-"));
    const project = path.join(allowedRoot, "project");
    const displaced = path.join(allowedRoot, "displaced-project");
    await fs.mkdir(project);
    const policy = new PathPolicy([allowedRoot]);
    const ensureDirectory = policy.ensureDirectory.bind(policy);
    let admissions = 0;
    vi.spyOn(policy, "ensureDirectory").mockImplementation(async (candidate, createDirectory) => {
      const admitted = await ensureDirectory(candidate, createDirectory);
      if (++admissions === 3) {
        await fs.rename(project, displaced);
        await fs.mkdir(project);
      }
      return admitted;
    });

    await expect(new WorktreeService(policy).getState(project)).rejects.toThrow(
      "Directory authority changed before capability use.",
    );
    await expect(fs.readdir(displaced)).resolves.toEqual([]);
    await expect(fs.readdir(project)).resolves.toEqual([]);
  });

  it("revalidates an authorized cwd immediately before spawning Git", async () => {
    const allowedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-pre-spawn-"));
    const project = path.join(allowedRoot, "project");
    const displaced = path.join(allowedRoot, "displaced-project");
    const marker = path.join(allowedRoot, "git-started");
    await fs.mkdir(project);
    const service = new WorktreeService(
      new PathPolicy([allowedRoot]),
      await markingGitExecutable(allowedRoot, marker),
    );
    const productionSeams = service as unknown as {
      requireExistingDirectory(candidate: string): Promise<{
        readonly canonicalPath: string;
        readonly dev: bigint;
        readonly ino: bigint;
      }>;
      runGit(
        cwd: { readonly canonicalPath: string; readonly dev: bigint; readonly ino: bigint },
        args: string[],
      ): Promise<unknown>;
    };
    const authority = await productionSeams.requireExistingDirectory(project);
    expect(Object.isFrozen(authority)).toBe(true);
    await fs.rename(project, displaced);
    await fs.mkdir(project);

    await expect(productionSeams.runGit(authority, ["--version"])).rejects.toThrow(
      "Directory authority changed before capability use.",
    );
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("starts no Git child for a pre-aborted mutation", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-pre-abort-"),
    );
    const marker = path.join(root, "git-started");
    const executable = await markingGitExecutable(root, marker);
    const service = worktreeService(executable);
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const cancellation = new Error("worktree mutation cancelled");
    const controller = new AbortController();
    controller.abort(cancellation);

    await expect(
      service.initializeBareRepository(project, { signal: controller.signal }),
    ).rejects.toBe(cancellation);
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("terminates a TERM-resistant Git process group before rejecting an aborted mutation", async () => {
    const service = worktreeService();
    const remote = await createRemoteRepo();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-cancel-"));
    const project = path.join(root, "project");
    await fs.mkdir(project);
    const cloned = await service.cloneBareRepository(project, remote);
    const baseRef = cloned.refs.find(
      (ref) =>
        ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
    )?.name;
    const marker = path.join(root, "git-started");
    const cancelledWorktree = path.join(project, "cancelled");
    const executable = await adversarialGitExecutable(root, marker, "hang");
    const cancellable = worktreeService(executable, {
      terminateGraceMs: 25,
    });
    const controller = new AbortController();
    const cancellation = new Error("stop Git now");

    const mutation = cancellable.createWorktree(
      project,
      {
        mode: "new_branch",
        folderName: "cancelled",
        branchName: "cancelled",
        baseRef,
      },
      { signal: controller.signal },
    );
    const pids = parsePids(await waitForTextFile(marker));
    controller.abort(cancellation);

    await expect(mutation).rejects.toBe(cancellation);
    await expectProcessesExited(pids);
    await expectNoWorktreeArtifacts(project, cancelledWorktree);
    await expect(cancellable.getState(project)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("terminates a resistant Git process group on deadline and remains usable", async () => {
    const { baseRef, project, root } =
      await createClonedProject("cloudx-wt-timeout-");
    const marker = path.join(root, "git-started");
    const worktreePath = path.join(project, "timed-out");
    const executable = await adversarialGitExecutable(
      root,
      marker,
      "deadline_hang",
    );
    const bounded = worktreeService(executable, {
      timeoutMs: 500,
      terminateGraceMs: 25,
    });
    await git(
      project,
      "--git-dir",
      path.join(project, ".bare"),
      "branch",
      "timed-out",
      baseRef,
    );

    const mutation = bounded.createWorktree(project, {
      mode: "new_branch",
      folderName: "timed-out",
      branchName: "timed-out",
      baseRef,
    });
    const rejection = mutation.then(
      () => undefined,
      (error: unknown) => error,
    );
    const pids = parsePids(await waitForTextFile(marker));

    await expect(rejection).resolves.toMatchObject({
      message: "Git command exceeded its 500 ms deadline.",
    });
    await expectProcessesExited(pids);
    await expectNoWorktreeArtifacts(project, worktreePath);
    await expect(bounded.getState(project)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("terminates a resistant Git process group when combined output exceeds its bound", async () => {
    const { baseRef, project, root } =
      await createClonedProject("cloudx-wt-output-");
    const marker = path.join(root, "git-started");
    const worktreePath = path.join(project, "overflowed");
    const executable = await adversarialGitExecutable(root, marker, "overflow");
    const bounded = worktreeService(executable, {
      maxOutputBytes: 512,
      terminateGraceMs: 25,
    });

    const mutation = bounded.createWorktree(project, {
      mode: "new_branch",
      folderName: "overflowed",
      branchName: "overflowed",
      baseRef,
    });
    const pids = parsePids(await waitForTextFile(marker));

    await expect(mutation).rejects.toThrow(
      "Git command output exceeded 512 bytes.",
    );
    await expectProcessesExited(pids);
    await expectNoWorktreeArtifacts(project, worktreePath);
    await expect(bounded.getState(project)).resolves.toMatchObject({
      status: "ready",
    });
  });

  it("reports failed Git administrative cleanup explicitly", async () => {
    const { baseRef, project, root } = await createClonedProject(
      "cloudx-wt-cleanup-failure-",
    );
    const marker = path.join(root, "git-started");
    const worktreePath = path.join(project, "cleanup-failed");
    const executable = await adversarialGitExecutable(
      root,
      marker,
      "cleanup_failure",
    );
    const bounded = worktreeService(executable, { terminateGraceMs: 25 });

    await expect(
      bounded.createWorktree(project, {
        mode: "new_branch",
        folderName: "cleanup-failed",
        branchName: "cleanup-failed",
        baseRef,
      }),
    ).rejects.toThrow(
      /Worktree creation failed and cleanup failed:.*controlled cleanup failure/,
    );
    await expect(fs.access(worktreePath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("serializes same-destination creates across service instances", async () => {
    const { baseRef, project, root } = await createClonedProject(
      "cloudx-wt-create-race-",
    );
    const entered = path.join(root, "entered");
    const release = path.join(root, "release");
    const identity = path.join(root, "reservation-identity");
    const destination = path.join(project, "shared");
    const executable = await gatedWorktreeGit(
      root,
      entered,
      release,
      destination,
      identity,
    );
    const firstService = worktreeService(executable);
    const secondService = worktreeService(executable);

    const first = firstService.createWorktree(
      project,
      createInput("shared", "shared", baseRef),
    );
    await waitForLines(entered, 1);
    const second = secondService.createWorktree(
      project,
      createInput("shared", "shared", baseRef),
    );

    await expectPending(second);
    expect(await readLines(entered)).toHaveLength(1);
    await fs.writeFile(release, "release\n");
    await expect(first).resolves.toMatchObject({
      worktrees: [expect.objectContaining({ folderName: "shared" })],
    });
    await expect(second).rejects.toThrow(
      "Worktree folder already exists: shared",
    );
    expect(await readLines(entered)).toHaveLength(1);
    await expect(
      fs.readFile(path.join(destination, "README.md"), "utf8"),
    ).resolves.toBe("hello\n");
    await expect(directoryIdentity(destination)).resolves.toBe(
      (await fs.readFile(identity, "utf8")).trim(),
    );
  });

  it("uses physical project identity when selected through a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { baseRef, project, root } = await createClonedProject(
      "cloudx-wt-project-alias-state-",
    );
    const projectAlias = path.join(root, "project-alias");
    const worktreePath = path.join(project, "physical-state");
    const service = worktreeService();
    await fs.symlink(project, projectAlias, "dir");
    await service.createWorktree(
      project,
      createInput("physical-state", "physical-state", baseRef),
    );

    await expect(service.getState(projectAlias)).resolves.toMatchObject({
      cwd: project,
      projectDir: project,
      barePath: path.join(project, ".bare"),
      worktrees: [
        expect.objectContaining({
          folderName: "physical-state",
          path: worktreePath,
        }),
      ],
    });
  });

  it("serializes real and symlink creates for one physical destination", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { baseRef, project, root } = await createClonedProject(
      "cloudx-wt-alias-create-race-",
    );
    const projectAlias = path.join(root, "project-alias");
    const entered = path.join(root, "entered");
    const release = path.join(root, "release");
    const identity = path.join(root, "reservation-identity");
    const destination = path.join(project, "shared-alias");
    await fs.symlink(project, projectAlias, "dir");
    const executable = await gatedWorktreeGit(
      root,
      entered,
      release,
      destination,
      identity,
    );
    const physicalService = worktreeService(executable);
    const aliasService = worktreeService(executable);

    const first = physicalService.createWorktree(
      project,
      createInput("shared-alias", "shared-alias", baseRef),
    );
    await waitForLines(entered, 1);
    const second = aliasService.createWorktree(
      projectAlias,
      createInput("shared-alias", "shared-alias", baseRef),
    );
    const secondSettledBeforeRelease = await settlesWithin(second);

    expect(await readLines(entered)).toHaveLength(1);
    await fs.writeFile(release, "release\n");
    await expect(first).resolves.toMatchObject({
      worktrees: [expect.objectContaining({ folderName: "shared-alias" })],
    });
    await expect(second).rejects.toThrow(
      "Worktree folder already exists: shared-alias",
    );
    expect(secondSettledBeforeRelease).toBe(false);
    expect(await readLines(entered)).toHaveLength(1);
    await expect(
      fs.readFile(path.join(destination, "README.md"), "utf8"),
    ).resolves.toBe("hello\n");
    await expect(directoryIdentity(destination)).resolves.toBe(
      (await fs.readFile(identity, "utf8")).trim(),
    );
    await expect(aliasService.getState(projectAlias)).resolves.toMatchObject({
      cwd: project,
      projectDir: project,
      worktrees: [
        expect.objectContaining({
          folderName: "shared-alias",
          path: destination,
        }),
      ],
    });
  });

  it("orders a real-path create before a symlink-path delete", async () => {
    if (process.platform === "win32") {
      return;
    }
    const { baseRef, project, root } = await createClonedProject(
      "cloudx-wt-alias-create-delete-",
    );
    const projectAlias = path.join(root, "project-alias");
    const entered = path.join(root, "entered");
    const release = path.join(root, "release");
    const destination = path.join(project, "ordered-alias");
    await fs.symlink(project, projectAlias, "dir");
    const executable = await gatedWorktreeGit(root, entered, release);
    const creator = worktreeService(executable);
    const deleter = worktreeService(executable);

    const create = creator.createWorktree(
      project,
      createInput("ordered-alias", "ordered-alias", baseRef),
    );
    await waitForLines(entered, 1);
    const remove = deleter.deleteWorktree(projectAlias, {
      folderName: "ordered-alias",
      confirmation: "ordered-alias",
    });
    const removeSettledBeforeRelease = await settlesWithin(remove);

    await fs.writeFile(release, "release\n");
    await expect(create).resolves.toMatchObject({ status: "ready" });
    await expect(remove).resolves.toMatchObject({
      cwd: project,
      projectDir: project,
      worktrees: [],
    });
    expect(removeSettledBeforeRelease).toBe(false);
    await expect(fs.access(destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(deleter.getState(projectAlias)).resolves.toMatchObject({
      cwd: project,
      projectDir: project,
      worktrees: [],
    });
  });

  it("rejects a queued create when its project alias changes ownership", async () => {
    if (process.platform === "win32") {
      return;
    }
    const firstProject = await createClonedProject(
      "cloudx-wt-alias-retarget-a-",
    );
    const secondProject = await createClonedProject(
      "cloudx-wt-alias-retarget-b-",
    );
    const projectAlias = path.join(firstProject.root, "project-alias");
    const entered = path.join(firstProject.root, "entered");
    const release = path.join(firstProject.root, "release");
    const firstDestination = path.join(firstProject.project, "retargeted");
    const secondDestination = path.join(secondProject.project, "retargeted");
    await fs.symlink(firstProject.project, projectAlias, "dir");
    const executable = await gatedWorktreeGit(
      firstProject.root,
      entered,
      release,
    );
    const physicalService = worktreeService(executable);
    const aliasService = worktreeService(executable);

    const first = physicalService.createWorktree(
      firstProject.project,
      createInput("retargeted", "retargeted", firstProject.baseRef),
    );
    await waitForLines(entered, 1);
    const queued = aliasService.createWorktree(
      projectAlias,
      createInput("retargeted", "retargeted", firstProject.baseRef),
    );
    const ownershipRejection = expect(queued).rejects.toThrow(
      "Worktree destination ownership changed while queued.",
    );
    const settledBeforeRetarget = await settlesWithin(queued);

    await fs.unlink(projectAlias);
    await fs.symlink(secondProject.project, projectAlias, "dir");
    const settledWhileQueued = await settlesWithin(queued);
    expect(await readLines(entered)).toHaveLength(1);
    await expect(fs.access(secondDestination)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await fs.writeFile(release, "release\n");
    await expect(first).resolves.toMatchObject({
      worktrees: [expect.objectContaining({ folderName: "retargeted" })],
    });
    await ownershipRejection;
    expect(settledBeforeRetarget).toBe(false);
    expect(settledWhileQueued).toBe(false);
    expect(await readLines(entered)).toHaveLength(1);
    await expect(fs.access(firstDestination)).resolves.toBeUndefined();
    await expect(fs.access(secondDestination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a queued delete when its project alias changes ownership", async () => {
    if (process.platform === "win32") return;
    const firstProject = await createClonedProject("cloudx-wt-delete-retarget-a-");
    const secondProject = await createClonedProject("cloudx-wt-delete-retarget-b-");
    const projectAlias = path.join(firstProject.root, "project-alias");
    const entered = path.join(firstProject.root, "entered");
    const release = path.join(firstProject.root, "release");
    const firstDestination = path.join(firstProject.project, "retargeted-delete");
    const secondDestination = path.join(secondProject.project, "retargeted-delete");
    await fs.symlink(firstProject.project, projectAlias, "dir");
    const executable = await gatedWorktreeGit(firstProject.root, entered, release);
    const policy = new PathPolicy([firstProject.root, secondProject.root]);
    const creator = new WorktreeService(policy, executable);
    const deleter = new WorktreeService(policy, executable);

    const create = creator.createWorktree(firstProject.project, createInput("retargeted-delete", "retargeted-delete", firstProject.baseRef));
    await waitForLines(entered, 1);
    const remove = deleter.deleteWorktree(projectAlias, { folderName: "retargeted-delete", confirmation: "retargeted-delete" });
    await expectPending(remove);
    await fs.unlink(projectAlias);
    await fs.symlink(secondProject.project, projectAlias, "dir");
    await fs.writeFile(release, "release\n");
    await expect(create).resolves.toMatchObject({ status: "ready" });
    await expect(remove).rejects.toThrow("Worktree destination ownership changed while queued.");
    await expect(fs.access(firstDestination)).resolves.toBeUndefined();
    await expect(fs.access(secondDestination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readLines(entered)).toHaveLength(1);
  });

  it("orders create then delete for one destination", async () => {
    const { baseRef, project, root } = await createClonedProject(
      "cloudx-wt-create-delete-",
    );
    const entered = path.join(root, "entered");
    const release = path.join(root, "release");
    const executable = await gatedWorktreeGit(root, entered, release);
    const creator = worktreeService(executable);
    const deleter = worktreeService(executable);

    const create = creator.createWorktree(
      project,
      createInput("ordered", "ordered", baseRef),
    );
    await waitForLines(entered, 1);
    const remove = deleter.deleteWorktree(project, {
      folderName: "ordered",
      confirmation: "ordered",
    });

    await expectPending(remove);
    await fs.writeFile(release, "release\n");
    await expect(create).resolves.toMatchObject({ status: "ready" });
    await expect(remove).resolves.toMatchObject({ worktrees: [] });
    await expect(
      fs.access(path.join(project, "ordered")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("continues a destination queue after one create rejects", async () => {
    const { baseRef, project, root } = await createClonedProject(
      "cloudx-wt-rejected-queue-",
    );
    const executable = await failFirstWorktreeAdd(root);
    const firstService = worktreeService(executable);
    const secondService = worktreeService(executable);

    await expect(
      firstService.createWorktree(
        project,
        createInput("recovered", "recovered", baseRef),
      ),
    ).rejects.toThrow("controlled first worktree failure");
    await expect(
      secondService.createWorktree(
        project,
        createInput("recovered", "recovered", baseRef),
      ),
    ).resolves.toMatchObject({
      worktrees: [expect.objectContaining({ folderName: "recovered" })],
    });
  });

  it("allows different destinations to enter Git concurrently", async () => {
    const { baseRef, project, root } = await createClonedProject(
      "cloudx-wt-different-destinations-",
    );
    const entered = path.join(root, "entered");
    const release = path.join(root, "release");
    const executable = await gatedWorktreeGit(root, entered, release);
    const firstService = worktreeService(executable);
    const secondService = worktreeService(executable);
    await git(
      project,
      "--git-dir",
      path.join(project, ".bare"),
      "branch",
      "first",
      baseRef,
    );
    await git(
      project,
      "--git-dir",
      path.join(project, ".bare"),
      "branch",
      "second",
      baseRef,
    );

    const first = firstService.createWorktree(project, {
      mode: "existing_branch",
      folderName: "first",
      branchName: "first",
    });
    const second = secondService.createWorktree(project, {
      mode: "existing_branch",
      folderName: "second",
      branchName: "second",
    });

    await waitForLines(entered, 2);
    await fs.writeFile(release, "release\n");
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it("preserves a replacement that no longer belongs to failed creation", async () => {
    const { baseRef, project, root } = await createClonedProject(
      "cloudx-wt-replacement-",
    );
    const destination = path.join(project, "replaced");
    const sentinel = path.join(destination, "sentinel.txt");
    const removeMarker = path.join(root, "remove-entered");
    const executable = await replacingWorktreeGit(
      root,
      destination,
      sentinel,
      removeMarker,
    );
    const service = worktreeService(executable);

    const error = await service
      .createWorktree(project, createInput("replaced", "replaced", baseRef))
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      expect.objectContaining({ message: "controlled worktree add failure" }),
      expect.objectContaining({
        message: expect.stringContaining("ownership"),
      }),
    ]);
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("foreign\n");
    await expect(fs.access(removeMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expectNoWorktreeRegistration(project, destination);
  });

  it("preserves a registered worktree replaced after dirty admission", async () => {
    const { baseRef, project, root } = await createClonedProject(
      "cloudx-wt-delete-replacement-",
    );
    const destination = path.join(project, "replaced-delete");
    const displaced = path.join(root, "displaced-worktree");
    const sentinel = path.join(destination, "foreign.txt");
    const removeMarker = path.join(root, "remove-entered");
    const pruneMarker = path.join(root, "prune-entered");
    const creator = worktreeService();
    await creator.createWorktree(
      project,
      createInput("replaced-delete", "replaced-delete", baseRef),
    );
    const service = worktreeService(
      await replacingWorktreeAfterStatusGit(
        root,
        destination,
        displaced,
        sentinel,
        removeMarker,
        pruneMarker,
      ),
    );

    await expect(
      service.deleteWorktree(project, {
        folderName: "replaced-delete",
        confirmation: "replaced-delete",
        force: true,
      }),
    ).rejects.toThrow("Worktree destination ownership changed before removal.");
    await expect(fs.readFile(sentinel, "utf8")).resolves.toBe("foreign\n");
    await expect(fs.access(displaced)).resolves.toBeUndefined();
    await expect(fs.access(removeMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.access(pruneMarker)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expectWorktreeRegistration(project, destination);
  });

  it("reports setup states for empty, blocked, and initialized projects", async () => {
    const service = worktreeService();
    const empty = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-empty-"));
    const blocked = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-blocked-"),
    );
    await fs.writeFile(path.join(blocked, "README.md"), "not empty\n");

    await expect(service.getState(empty)).resolves.toMatchObject({
      status: "empty",
      setup: { canInitialize: true, canClone: true },
    });
    await expect(service.getState(blocked)).resolves.toMatchObject({
      status: "blocked",
      setup: { canInitialize: false, canClone: false },
    });

    const initialized = await service.initializeBareRepository(empty);
    expect(initialized).toMatchObject({
      status: "ready",
      worktrees: [],
      refs: [],
    });
    await expect(
      fs.stat(path.join(empty, ".bare", "HEAD")),
    ).resolves.toBeTruthy();
  });

  it("clones refs, creates worktrees, blocks dirty deletion, and force deletes after confirmation", async () => {
    const service = worktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-project-"),
    );

    const cloned = await service.cloneBareRepository(project, remote);
    expect(cloned).toMatchObject({ status: "ready", originUrl: remote });
    expect(cloned.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "remote",
          name: expect.stringMatching(/^origin\/(main|master)$/),
        }),
        expect.objectContaining({ kind: "remote", name: "origin/feature" }),
        expect.objectContaining({ kind: "tag", name: "v1" }),
      ]),
    );

    const baseRef = cloned.refs.find(
      (ref) =>
        ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
    )?.name;
    expect(baseRef).toBeTruthy();
    const withWorktree = await service.createWorktree(project, {
      mode: "new_branch",
      folderName: "feature-ui",
      branchName: "feature-ui",
      baseRef,
    });
    expect(withWorktree.worktrees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          folderName: "feature-ui",
          branch: "feature-ui",
          dirty: expect.objectContaining({ dirty: false }),
        }),
      ]),
    );
    await expect(
      fs.readFile(path.join(project, "feature-ui", "README.md"), "utf8"),
    ).resolves.toBe("hello\n");

    await fs.writeFile(
      path.join(project, "feature-ui", "README.md"),
      "changed\n",
    );
    const dirty = await service.getState(project);
    expect(dirty.worktrees[0]).toMatchObject({
      dirty: { dirty: true, unstaged: 1 },
    });
    await expect(
      service.deleteWorktree(project, {
        folderName: "feature-ui",
        confirmation: "feature-ui",
      }),
    ).rejects.toThrow("Force confirmation");
    await expect(
      service.deleteWorktree(project, {
        folderName: "feature-ui",
        confirmation: "feature-ui",
        force: true,
      }),
    ).resolves.toMatchObject({ worktrees: [] });
    await expect(
      fs.stat(path.join(project, "feature-ui")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans up failed bare clone setup so the project can be retried", async () => {
    const service = worktreeService();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-clone-fail-"),
    );
    const missingRemote = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-missing-")),
      "missing.git",
    );

    await expect(
      service.cloneBareRepository(project, missingRemote),
    ).rejects.toThrow();

    await expect(fs.stat(path.join(project, ".bare"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(service.getState(project)).resolves.toMatchObject({
      status: "empty",
      setup: { canClone: true, canInitialize: true },
    });
  });

  it("treats clone URLs that start with a dash as remote URL operands", async () => {
    const service = worktreeService();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-dash-url-"),
    );

    await expect(
      service.cloneBareRepository(project, "--upload-pack=/definitely/missing"),
    ).rejects.not.toThrow("unknown option");
    await expect(fs.stat(path.join(project, ".bare"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates a local tracking branch from a remote branch and rejects path traversal folders", async () => {
    const service = worktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-track-"),
    );
    await service.cloneBareRepository(project, remote);

    await expect(
      service.createWorktree(project, {
        mode: "remote_branch",
        folderName: "tracked-feature",
        branchName: "tracked-feature",
        baseRef: "origin/feature",
      }),
    ).resolves.toMatchObject({
      worktrees: [
        expect.objectContaining({
          folderName: "tracked-feature",
          branch: "tracked-feature",
        }),
      ],
    });

    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName: "../escape",
        branchName: "escape",
        baseRef: "origin/feature",
      }),
    ).rejects.toThrow("folderName");
  });

  it("allows direct child worktree folders whose names start with two dots", async () => {
    const service = worktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-dotdot-child-"),
    );
    const cloned = await service.cloneBareRepository(project, remote);
    const baseRef = cloned.refs.find(
      (ref) =>
        ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
    )?.name;
    expect(baseRef).toBeTruthy();

    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName: "..feature",
        branchName: "feature-dot",
        baseRef,
      }),
    ).resolves.toMatchObject({
      worktrees: [
        expect.objectContaining({
          folderName: "..feature",
          branch: "feature-dot",
        }),
      ],
    });
    await expect(
      fs.readFile(path.join(project, "..feature", "README.md"), "utf8"),
    ).resolves.toBe("hello\n");
  });

  it("parses worktree paths with newlines and validates branch names with Git", async () => {
    const service = worktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-paths-"),
    );
    const cloned = await service.cloneBareRepository(project, remote);
    const baseRef = cloned.refs.find(
      (ref) =>
        ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
    )?.name;
    expect(baseRef).toBeTruthy();

    const folderName = "line\nworktree";
    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName,
        branchName: "line-worktree",
        baseRef,
      }),
    ).resolves.toMatchObject({
      worktrees: [
        expect.objectContaining({ folderName, branch: "line-worktree" }),
      ],
    });

    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName: "invalid-branch",
        branchName: "bad.lock",
        baseRef,
      }),
    ).rejects.toThrow("branchName is not a valid Git branch name.");
    await expect(
      fs.stat(path.join(project, "invalid-branch")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("creates new branches from listed refs whose short names start with a dash", async () => {
    const service = worktreeService();
    const remote = await createRemoteRepo();
    await git(remote, "update-ref", "refs/tags/--base", "HEAD");
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-dash-start-point-"),
    );
    const cloned = await service.cloneBareRepository(project, remote);
    const dashTag = cloned.refs.find(
      (ref) => ref.kind === "tag" && ref.name === "--base",
    );

    expect(dashTag).toBeTruthy();
    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName: "from-dash-tag",
        branchName: "from-dash-tag",
        baseRef: dashTag?.name,
      }),
    ).resolves.toMatchObject({
      worktrees: [
        expect.objectContaining({
          folderName: "from-dash-tag",
          branch: "from-dash-tag",
        }),
      ],
    });
    await expect(
      gitOutput(
        path.join(project, "from-dash-tag"),
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ),
    ).resolves.toBe("from-dash-tag");
  });

  it("optionally reports worktree folder size without following symlinks", async () => {
    const service = worktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-size-"));
    const cloned = await service.cloneBareRepository(project, remote);
    const baseRef = cloned.refs.find(
      (ref) =>
        ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
    )?.name;
    expect(baseRef).toBeTruthy();

    await service.createWorktree(project, {
      mode: "new_branch",
      folderName: "sized",
      branchName: "sized",
      baseRef,
    });
    await fs.writeFile(path.join(project, "sized", "extra.bin"), "12345");
    const symlinkTarget = path.join(project, "outside-large.bin");
    await fs.writeFile(symlinkTarget, "x".repeat(10_000));
    await fs.symlink(
      symlinkTarget,
      path.join(project, "sized", "outside-large.bin"),
    );

    const withoutSizes = await service.getState(project);
    expect(withoutSizes.worktrees[0]?.sizeBytes).toBeUndefined();

    const initialSizeState = await service.getState(project, {
      includeSizes: true,
    });
    expect(initialSizeState.worktrees[0]).toMatchObject({ sizePending: true });
    expect(initialSizeState.worktrees[0]?.sizeBytes).toBeUndefined();

    const withCachedSize = await waitForWorktreeSize(service, project);
    expect(withCachedSize.worktrees[0]?.sizeBytes).toEqual(expect.any(Number));
    expect(withCachedSize.worktrees[0]?.sizeBytes).toBeLessThan(10_000);
    expect(withCachedSize.worktrees[0]?.sizePending).toBeUndefined();

    const cachedAgain = await service.getState(project, { includeSizes: true });
    expect(cachedAgain.worktrees[0]?.sizeBytes).toBe(
      withCachedSize.worktrees[0]?.sizeBytes,
    );
    expect(cachedAgain.worktrees[0]?.sizePending).toBeUndefined();
  });

  it("fetches remote branches and syncs divergent tags", async () => {
    const service = worktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-tags-"));
    const cloned = await service.cloneBareRepository(project, remote);
    expect(cloned.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "remote", name: "origin/feature" }),
      ]),
    );

    await git(
      project,
      "--git-dir",
      path.join(project, ".bare"),
      "tag",
      "moved-tag",
      cloned.refs.find(
        (ref) => ref.kind === "remote" && ref.name === "origin/feature",
      )?.commit ?? "HEAD",
    );
    await fs.writeFile(path.join(remote, "REMOTE.md"), "updated\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "move remote tag");
    await git(remote, "tag", "moved-tag");
    const remoteTagCommit = await gitOutput(remote, "rev-parse", "moved-tag");

    const fetched = await service.fetchRefs(project);
    expect(fetched).toMatchObject({
      status: "ready",
      refs: expect.arrayContaining([
        expect.objectContaining({ kind: "remote", name: "origin/feature" }),
      ]),
    });
    expect(
      await gitOutput(
        project,
        "--git-dir",
        path.join(project, ".bare"),
        "rev-parse",
        "moved-tag",
      ),
    ).toBe(remoteTagCommit);
  });

  it("preserves remote branches whose names end in HEAD", async () => {
    const service = worktreeService();
    const remote = await createRemoteRepo();
    await git(remote, "branch", "topic/HEAD");
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-head-suffix-"),
    );

    const cloned = await service.cloneBareRepository(project, remote);

    expect(cloned.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "remote", name: "origin/topic/HEAD" }),
      ]),
    );
    expect(cloned.refs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "remote", name: "origin/HEAD" }),
      ]),
    );
  });

  it("updates origin tracking branches without moving checked-out local branches", async () => {
    const service = worktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-checked-out-"),
    );
    await service.cloneBareRepository(project, remote);
    await service.createWorktree(project, {
      mode: "remote_branch",
      folderName: "feature-worktree",
      branchName: "feature",
      baseRef: "origin/feature",
    });
    const localFeatureBefore = await gitOutput(
      project,
      "--git-dir",
      path.join(project, ".bare"),
      "rev-parse",
      "refs/heads/feature",
    );

    await git(remote, "checkout", "feature");
    await fs.writeFile(path.join(remote, "FEATURE.md"), "updated\n");
    await git(remote, "add", ".");
    await git(remote, "commit", "-m", "advance feature");
    const remoteFeatureAfter = await gitOutput(remote, "rev-parse", "feature");

    await service.fetchRefs(project);

    expect(
      await gitOutput(
        project,
        "--git-dir",
        path.join(project, ".bare"),
        "rev-parse",
        "refs/heads/feature",
      ),
    ).toBe(localFeatureBefore);
    expect(
      await gitOutput(
        project,
        "--git-dir",
        path.join(project, ".bare"),
        "rev-parse",
        "refs/remotes/origin/feature",
      ),
    ).toBe(remoteFeatureAfter);
    expect(
      await gitOutput(
        path.join(project, "feature-worktree"),
        "status",
        "--porcelain",
      ),
    ).toBe("");
  });

  it("detects a single non-.bare repository child and the bare directory itself", async () => {
    const service = worktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-named-bare-"),
    );
    const barePath = path.join(project, "repo.git");
    await git(project, "clone", "--bare", remote, barePath);

    await expect(service.getState(project)).resolves.toMatchObject({
      status: "ready",
      cwd: project,
      projectDir: project,
      barePath,
      bareName: "repo.git",
      detectedFrom: "project_dir",
    });
    await expect(service.getState(barePath)).resolves.toMatchObject({
      status: "ready",
      cwd: barePath,
      projectDir: project,
      barePath,
      bareName: "repo.git",
      detectedFrom: "bare_dir",
    });
    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName: "repo.git",
        branchName: "repo-git-worktree",
        baseRef: "master",
      }),
    ).rejects.toThrow("folderName");
  });

  it("blocks symlinked .bare repositories instead of managing a repository outside the project", async () => {
    if (process.platform === "win32") {
      return;
    }
    const service = worktreeService();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-linked-bare-"),
    );
    const outside = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-outside-bare-"),
    );
    const outsideBare = path.join(outside, "repo.git");
    await git(outside, "init", "--bare", outsideBare);
    await fs.symlink(outsideBare, path.join(project, ".bare"), "dir");

    await expect(service.getState(project)).resolves.toMatchObject({
      status: "blocked",
      setup: {
        canInitialize: false,
        canClone: false,
        blockedReason: ".bare exists but is not a valid bare Git repository.",
      },
    });
    await expect(
      service.createWorktree(project, {
        mode: "new_branch",
        folderName: "feature",
        branchName: "feature",
        baseRef: "HEAD",
      }),
    ).rejects.toThrow(".bare exists but is not a valid bare Git repository.");
  });

  it("detects a selected linked worktree and creates new worktrees beside it", async () => {
    const service = worktreeService();
    const remote = await createRemoteRepo();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-linked-"),
    );
    const cloned = await service.cloneBareRepository(project, remote);
    const baseRef = cloned.refs.find(
      (ref) =>
        ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
    )?.name;
    expect(baseRef).toBeTruthy();

    await service.createWorktree(project, {
      mode: "new_branch",
      folderName: "primary",
      branchName: "primary",
      baseRef,
    });
    const selectedWorktree = path.join(project, "primary");

    await expect(service.getState(selectedWorktree)).resolves.toMatchObject({
      status: "ready",
      cwd: selectedWorktree,
      projectDir: project,
      barePath: path.join(project, ".bare"),
      bareName: ".bare",
      detectedFrom: "worktree_dir",
      worktrees: [expect.objectContaining({ folderName: "primary" })],
    });

    await expect(
      service.createWorktree(selectedWorktree, {
        mode: "new_branch",
        folderName: "secondary",
        branchName: "secondary",
        baseRef,
      }),
    ).resolves.toMatchObject({
      cwd: selectedWorktree,
      projectDir: project,
      worktrees: [
        expect.objectContaining({ folderName: "primary" }),
        expect.objectContaining({ folderName: "secondary" }),
      ],
    });
    await expect(
      fs.stat(path.join(project, "secondary", "README.md")),
    ).resolves.toBeTruthy();
  });

  it("blocks ambiguous directories with multiple bare repository children", async () => {
    const service = worktreeService();
    const project = await fs.mkdtemp(
      path.join(os.tmpdir(), "cloudx-wt-ambiguous-"),
    );
    await git(project, "init", "--bare", "one.git");
    await git(project, "init", "--bare", "two.git");

    await expect(service.getState(project)).resolves.toMatchObject({
      status: "blocked",
      setup: {
        canInitialize: false,
        canClone: false,
        blockedReason:
          "Multiple bare Git repositories were found under the selected directory.",
        candidateBarePaths: [
          path.join(project, "one.git"),
          path.join(project, "two.git"),
        ],
      },
    });
  });
});

async function createRemoteRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cloudx-wt-remote-"));
  await git(root, "init");
  await git(root, "config", "user.name", "Cloudx Test");
  await git(root, "config", "user.email", "cloudx@example.test");
  await fs.writeFile(path.join(root, "README.md"), "hello\n");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  await git(root, "tag", "v1");
  await git(root, "branch", "feature");
  return root;
}

async function createClonedProject(
  prefix: string,
): Promise<{ baseRef: string; project: string; root: string }> {
  const service = worktreeService();
  const remote = await createRemoteRepo();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const cloned = await service.cloneBareRepository(project, remote);
  const baseRef = cloned.refs.find(
    (ref) => ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
  )?.name;
  if (!baseRef)
    throw new Error(
      "Expected the cloned repository to expose its default remote branch.",
    );
  return { baseRef, project, root };
}

async function createConfiguredSymlinkRootProject(prefix: string) {
  const remote = await createRemoteRepo();
  const physicalRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), `${prefix}physical-`),
  );
  const expressionParent = await fs.mkdtemp(
    path.join(os.tmpdir(), `${prefix}expression-`),
  );
  const configuredRoot = path.join(expressionParent, "configured-root");
  const physicalProject = path.join(physicalRoot, "project");
  const projectExpression = path.join(configuredRoot, "project");
  const mutationLog = path.join(expressionParent, "worktree-mutations");
  await fs.mkdir(physicalProject);
  await fs.symlink(physicalRoot, configuredRoot, "dir");
  const service = new WorktreeService(
    new PathPolicy([configuredRoot]),
    await countingWorktreeGit(expressionParent, mutationLog),
  );
  const cloned = await service.cloneBareRepository(projectExpression, remote);
  const baseRef = cloned.refs.find(
    (ref) => ref.kind === "remote" && ref.name.match(/^origin\/(main|master)$/),
  )?.name;
  if (!baseRef) {
    throw new Error(
      "Expected the symlink-root repository to expose its default remote branch.",
    );
  }
  return {
    baseRef,
    mutationLog,
    physicalProject,
    projectExpression,
    service,
  };
}

function worktreeService(
  gitExecutable = "git",
  limits: ConstructorParameters<typeof WorktreeService>[2] = {},
): WorktreeService {
  return new WorktreeService(new PathPolicy([os.tmpdir()]), gitExecutable, limits);
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitOutput(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

async function markingGitExecutable(
  root: string,
  marker: string,
): Promise<string> {
  const executable = path.join(root, "marking-git");
  await fs.writeFile(
    executable,
    `#!/bin/sh\nprintf started > ${JSON.stringify(marker)}\nexec git "$@"\n`,
    { mode: 0o700 },
  );
  return executable;
}

async function countingWorktreeGit(
  root: string,
  mutationLog: string,
): Promise<string> {
  const executable = path.join(root, "counting-worktree-git");
  await fs.writeFile(
    executable,
    `#!/bin/sh\ncase " $* " in\n  *" worktree add "*) printf 'add\\n' >> ${JSON.stringify(mutationLog)} ;;\n  *" worktree remove "*) printf 'remove\\n' >> ${JSON.stringify(mutationLog)} ;;\nesac\nexec git "$@"\n`,
    { mode: 0o700 },
  );
  return executable;
}

function createInput(folderName: string, branchName: string, baseRef: string) {
  return { mode: "new_branch" as const, folderName, branchName, baseRef };
}

async function gatedWorktreeGit(
  root: string,
  entered: string,
  release: string,
  observedDestination?: string,
  observedIdentity?: string,
): Promise<string> {
  const executable = path.join(root, "gated-git");
  const observe =
    observedDestination && observedIdentity
      ? `[ -d ${JSON.stringify(observedDestination)} ] || exit 31\n[ -z "$(ls -A -- ${JSON.stringify(observedDestination)})" ] || exit 32\nstat -c '%d:%i' -- ${JSON.stringify(observedDestination)} > ${JSON.stringify(observedIdentity)}\n`
      : "";
  await fs.writeFile(
    executable,
    `#!/bin/sh\ncase " $* " in\n  *" worktree add "*)\n    ${observe}printf '%s\\n' "$*" >> ${JSON.stringify(entered)}\n    while [ ! -e ${JSON.stringify(release)} ]; do sleep 0.01; done\n    ;;\nesac\nexec git "$@"\n`,
    { mode: 0o700 },
  );
  return executable;
}

async function failFirstWorktreeAdd(root: string): Promise<string> {
  const executable = path.join(root, "fail-first-git");
  const failed = path.join(root, "failed-once");
  await fs.writeFile(
    executable,
    `#!/bin/sh\ncase " $* " in\n  *" worktree add "*)\n    if [ ! -e ${JSON.stringify(failed)} ]; then\n      touch ${JSON.stringify(failed)}\n      printf 'controlled first worktree failure' >&2\n      exit 17\n    fi\n    ;;\nesac\nexec git "$@"\n`,
    { mode: 0o700 },
  );
  return executable;
}

async function replacingWorktreeGit(
  root: string,
  destination: string,
  sentinel: string,
  removeMarker: string,
): Promise<string> {
  const executable = path.join(root, "replacing-git");
  const replacement = path.join(root, "foreign-replacement");
  await fs.mkdir(replacement);
  await fs.writeFile(
    path.join(replacement, path.basename(sentinel)),
    "foreign\n",
  );
  await fs.writeFile(
    executable,
    `#!/bin/sh\ncase " $* " in\n  *" worktree add "*)\n    [ -d ${JSON.stringify(destination)} ] || exit 31\n    [ -z "$(ls -A -- ${JSON.stringify(destination)})" ] || exit 32\n    rmdir -- ${JSON.stringify(destination)}\n    mv -- ${JSON.stringify(replacement)} ${JSON.stringify(destination)}\n    printf 'controlled worktree add failure' >&2\n    exit 17\n    ;;\n  *" worktree remove "*)\n    printf entered > ${JSON.stringify(removeMarker)}\n    ;;\nesac\nexec git "$@"\n`,
    { mode: 0o700 },
  );
  return executable;
}

async function replacingWorktreeAfterStatusGit(
  root: string,
  destination: string,
  displaced: string,
  sentinel: string,
  removeMarker: string,
  pruneMarker: string,
): Promise<string> {
  const executable = path.join(root, "replacing-after-status-git");
  const replacement = path.join(root, "foreign-delete-replacement");
  const replaced = path.join(root, "replacement-complete");
  await fs.mkdir(replacement);
  await fs.writeFile(
    path.join(replacement, path.basename(sentinel)),
    "foreign\n",
  );
  await fs.writeFile(
    executable,
    `#!/bin/sh\ncase " $* " in\n  *" status --porcelain=v2 "*)\n    git "$@" || exit $?\n    if [ ! -e ${JSON.stringify(replaced)} ]; then\n      mv -- ${JSON.stringify(destination)} ${JSON.stringify(displaced)}\n      mv -- ${JSON.stringify(replacement)} ${JSON.stringify(destination)}\n      touch ${JSON.stringify(replaced)}\n    fi\n    exit 0\n    ;;\n  *" worktree remove "*)\n    printf entered > ${JSON.stringify(removeMarker)}\n    ;;\n  *" worktree prune "*)\n    printf entered > ${JSON.stringify(pruneMarker)}\n    ;;\nesac\nexec git "$@"\n`,
    { mode: 0o700 },
  );
  return executable;
}

async function adversarialGitExecutable(
  root: string,
  marker: string,
  mode: "hang" | "deadline_hang" | "overflow" | "cleanup_failure",
): Promise<string> {
  const executable = path.join(root, `adversarial-git-${mode}`);
  const cleanupFailure =
    mode === "cleanup_failure"
      ? `case " $* " in *" worktree remove "*|*" worktree prune "*) printf 'controlled cleanup failure' >&2; exit 19;; esac\n`
      : "";
  const resistantHang = `trap '' TERM\nsh -c 'trap "" TERM; while :; do sleep 60; done' &\ndescendant=$!\nprintf '%s %s' "$$" "$descendant" > ${JSON.stringify(marker)}\n${mode === "overflow" ? "head -c 4096 /dev/zero | tr '\\000' x\n" : ""}while :; do sleep 60; done`;
  const worktreeAdd =
    mode === "cleanup_failure"
      ? `git "$@" || exit $?\nprintf 'controlled worktree failure' >&2\nexit 17`
      : `${mode === "deadline_hang" ? "" : 'git "$@" || exit $?\n'}${resistantHang}`;
  await fs.writeFile(
    executable,
    `#!/bin/sh\n${cleanupFailure}case " $* " in\n  *" worktree add "*)\n${worktreeAdd}\n    ;;\nesac\nexec git "$@"\n`,
    { mode: 0o700 },
  );
  return executable;
}

function parsePids(value: string): number[] {
  const pids = value.split(" ").map(Number);
  if (
    pids.length !== 2 ||
    pids.some((pid) => !Number.isInteger(pid) || pid <= 0)
  ) {
    throw new Error(`Expected two process IDs, received: ${value}`);
  }
  return pids;
}

async function waitForTextFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const text = await fs.readFile(filePath, "utf8").catch(() => "");
    if (text) return text;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${filePath}.`);
}

async function readLines(filePath: string): Promise<string[]> {
  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

async function waitForLines(filePath: string, count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await readLines(filePath)).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} entries in ${filePath}.`);
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  const settled = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  expect(settled).toBe(false);
}

async function settlesWithin(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
}

async function directoryIdentity(directory: string): Promise<string> {
  const stat = await fs.lstat(directory, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

async function expectProcessesExited(pids: number[]): Promise<void> {
  for (const pid of pids) {
    expect(
      await processIsRunning(pid),
      `process ${pid} was still running when the command rejected`,
    ).toBe(false);
  }
}

async function processIsRunning(pid: number): Promise<boolean> {
  const state = await fs
    .readFile(`/proc/${pid}/stat`, "utf8")
    .catch(() => undefined);
  if (state) return state.split(" ")[2] !== "Z";
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function expectNoWorktreeArtifacts(
  project: string,
  worktreePath: string,
): Promise<void> {
  await expect(fs.access(worktreePath)).rejects.toMatchObject({
    code: "ENOENT",
  });
  const registered = await gitOutput(
    project,
    "--git-dir",
    path.join(project, ".bare"),
    "worktree",
    "list",
    "--porcelain",
    "-z",
  );
  expect(registered).not.toContain(`worktree ${worktreePath}\0`);
}

async function expectNoWorktreeRegistration(
  project: string,
  worktreePath: string,
): Promise<void> {
  const registered = await gitOutput(
    project,
    "--git-dir",
    path.join(project, ".bare"),
    "worktree",
    "list",
    "--porcelain",
    "-z",
  );
  expect(registered).not.toContain(`worktree ${worktreePath}\0`);
}

async function expectWorktreeRegistration(
  project: string,
  worktreePath: string,
): Promise<void> {
  const registered = await gitOutput(
    project,
    "--git-dir",
    path.join(project, ".bare"),
    "worktree",
    "list",
    "--porcelain",
    "-z",
  );
  expect(registered).toContain(`worktree ${worktreePath}\0`);
}

async function waitForWorktreeSize(
  service: WorktreeService,
  project: string,
): Promise<WorktreeProjectState> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const state = await service.getState(project, { includeSizes: true });
    if (
      typeof state.worktrees[0]?.sizeBytes === "number" ||
      state.worktrees[0]?.sizeError
    ) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for worktree size cache.");
}

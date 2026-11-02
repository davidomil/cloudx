export const CLAUDE_LAUNCH_MODES = ["native-project", "cloudx-managed"];
export function resolveClaudeLaunchMode(requested, saved) {
    if (requested !== undefined) {
        if (!CLAUDE_LAUNCH_MODES.some(mode => mode === requested))
            throw new Error("Claude launch mode must be native-project or cloudx-managed. Omit it to inherit the saved future-launch preference.");
        return { mode: requested, source: "launch" };
    }
    return saved ? { mode: saved, source: "saved" } : { mode: "native-project", source: "default" };
}
export function parseClaudeResolvedLaunchPolicy(value) {
    const fail = () => { throw new Error("Invalid recorded Claude launch policy. Restore a verified execution policy before resuming; current settings cannot replace it."); };
    const record = (input, keys) => Boolean(input && typeof input === "object" && !Array.isArray(input) && Object.keys(input).every(key => keys.includes(key)));
    const text = (input, maximum) => typeof input === "string" && input.length > 0 && input.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(input);
    const hash = (input) => typeof input === "string" && /^[a-f0-9]{64}$/u.test(input);
    const strings = (input, maximum) => Array.isArray(input) && input.length <= maximum && input.every(item => text(item, 256)) && new Set(input).size === input.length;
    if (!record(value, ["mode", "contractVersion", "nativeVersion", "exclusiveSkills", "activation", "settingSources", "includedSources", "excludedSources", "skills", "sourceFiles"]) ||
        !CLAUDE_LAUNCH_MODES.some(mode => mode === value.mode) || value.contractVersion !== 1 || value.activation !== "next-launch" ||
        value.exclusiveSkills !== (value.mode === "cloudx-managed") || !text(value.nativeVersion, 64) ||
        (!/^\d+\.\d+\.\d+(?: \(Claude Code\))?$/u.test(value.nativeVersion) && !(value.mode === "native-project" && value.nativeVersion === "unobserved")) ||
        !strings(value.settingSources, 3) || value.settingSources.some(source => !["user", "project", "local"].includes(source)) ||
        !strings(value.includedSources, 64) || !strings(value.excludedSources, 64) ||
        !Array.isArray(value.skills) || value.skills.length > 2_000)
        return fail();
    if (value.mode === "cloudx-managed" && (value.settingSources.length !== 1 || value.settingSources[0] !== "user" || value.nativeVersion.replace(" (Claude Code)", "") !== "2.1.316"))
        return fail();
    const settingSources = value.settingSources;
    if (value.mode === "native-project" && (settingSources.length !== 3 || !["user", "project", "local"].every(source => settingSources.includes(source))))
        return fail();
    const origins = ["cloudx-system", "selected-template", "personal", "synced"];
    for (const skill of value.skills) {
        if (!record(skill, ["name", "origin", "sourcePath", "sha256", "account", "nativeSource"]) || !text(skill.name, 128) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(skill.name) ||
            !origins.includes(skill.origin) || !text(skill.sourcePath, 4096) || !hash(skill.sha256) ||
            (skill.nativeSource !== undefined && skill.nativeSource !== "user") ||
            (skill.origin === "synced" && !text(skill.account, 128)) ||
            (skill.account !== undefined && (skill.origin !== "synced" || !text(skill.account, 128) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(skill.account))))
            return fail();
    }
    if (new Set(value.skills.map(skill => skill.name)).size !== value.skills.length)
        return fail();
    if (value.sourceFiles !== undefined) {
        if (!Array.isArray(value.sourceFiles) || value.sourceFiles.length > 2_000)
            return fail();
        for (const source of value.sourceFiles)
            if (!record(source, ["path", "state", "sha256"]) || !text(source.path, 4096) || !["file", "missing"].includes(source.state) ||
                (source.state === "file" ? !hash(source.sha256) : source.sha256 !== undefined))
                return fail();
    }
    return structuredClone(value);
}

// A conversation has no transcript yet. Claude Code and Codex write one only
// once the conversation receives its first prompt.
export class MissingTranscriptError extends Error {}

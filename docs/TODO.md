# Cloudx Todo

## Roadmap Items

- [ ] Worktree manager plugin
  - Add a plugin for discovering, creating, switching, and cleaning up Git worktrees.
  - Expose voice-safe actions for common worktree operations.

- [ ] Plugin installation from GitHub
  - Add a flow for installing Cloudx plugins from a GitHub repository URL.
  - Validate plugin metadata before enabling an installed plugin.

- [ ] Layout templates
  - Add a templates button next to the split controls.
  - Allow creating a pane/tab layout from a saved template.
  - Allow saving the current layout as a template.
  - Save templates relative to a selected base path so restored layouts can preserve relative paths on top of a new project path.

- [ ] Git diff rendering in file browser
  - Add a file-browser view for rendered Git diffs.
  - Add a banner-like control at the top of the plugin for choosing the branch to diff against.
  - Default to diffing against the tip of the repository's default branch when no comparison branch is selected.
  - Support inspecting changed files and hunks from the current working directory.

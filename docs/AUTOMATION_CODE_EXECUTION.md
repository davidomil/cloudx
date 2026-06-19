# Automation Code Execution

Cloudx automation includes code-execution primitives for cases where a graph
needs logic that would be awkward to model with individual nodes. Use them when
the graph still needs normal automation triggers, safety controls, visible run
trace, and typed output ports.

## Run Python

`primitive:python.exec` runs the configured source through `python3 -c` in a
bounded subprocess. It has external automation safety because the code can read
files under allowed roots, run imports available to the system Python, and call
Cloudx hooks when hook helpers are enabled.

Key inputs:

- `Code`: Python source. The editor supports Python syntax highlighting,
  built-in Python completions, and Cloudx helper completions.
- `STDIN`: optional UTF-8 text available through `sys.stdin.read()`.
- `CWD`: optional working directory. Relative paths resolve from the first
  configured Cloudx allowed root.
- `Timeout`: process timeout in milliseconds. The runtime also enforces the
  remaining automation-run duration budget.
- `CloudX Hooks`: enabled by default. When enabled, the Python process gets
  `cloudx.call_hook(...)` and the shorter `call_hook(...)` alias.
- `Parse JSON`: when enabled, stdout must be JSON and is exposed on the `JSON`
  output port.

Outputs:

- `STDOUT`, `STDERR`, and `Exit Code` expose process results.
- `JSON` exposes parsed stdout when `Parse JSON` is enabled.
- `Hook Results` contains Cloudx hook return objects in call order.
- `Hook Count` contains the number of hook calls executed.

Runtime limits:

- Python source is capped at 100,000 characters.
- Python STDIN is capped at 1 MiB.
- Captured stdout and stderr are capped at 1 MiB each.
- Python timeout is capped at 5 minutes and cannot exceed the remaining
  automation-run duration budget.

## Calling Cloudx Hooks From Python

Use this form:

```python
cloudx.call_hook("notifications.send", {
    "title": "Automation finished",
    "body": "The Python step completed.",
    "level": "success",
})
```

The alias is equivalent:

```python
call_hook("notifications.send", {"title": "Done"})
```

Rules:

- Pass the hook registry ID, for example `notifications.send`,
  `workspace.shell.runCommand`, or `jira.issues.search`.
- Do not include the graph node prefix `hook:`. The automation palette shows
  node type IDs such as `hook:notifications.send`, but Python hook calls use
  `notifications.send`.
- The second argument must be a JSON-like Python dictionary. Cloudx validates it
  against the hook input schema before executing the hook.
- `target_tab_id` is optional. Use it only for plugin-owned hooks that should run
  against a specific tab.
- `cloudx.call_hook(...)` returns `None` inside Python. Hook results become
  available after the Python process exits on the `Hook Results` output port.
- Cloudx removes the internal hook request lines from `STDOUT`, so normal stdout
  remains clean for logs or `Parse JSON`.
- If the Python process exits non-zero, queued hook calls are not executed.

Example with a shell hook:

```python
cloudx.call_hook("workspace.shell.runCommand", {
    "command": "git status --short",
    "cwd": ".",
    "timeoutMs": 30000,
})
```

Example with an explicit target tab:

```python
cloudx.call_hook(
    "codex-terminal.enterText",
    {"text": "summarize the current diff", "submit": True},
    target_tab_id="tab-id-from-the-workspace",
)
```

Example that emits structured JSON and also calls a hook:

```python
import json
import sys

payload = sys.stdin.read()
cloudx.call_hook("notifications.send", {"title": "Received input"})
print(json.dumps({"inputBytes": len(payload.encode("utf-8"))}))
```

Enable `Parse JSON` for that node to expose `{"inputBytes": ...}` on the `JSON`
output port. The notification result appears separately in `Hook Results`.

## Finding Hook IDs And Inputs

The Automation palette shows hook nodes with readable titles. For exact IDs and
schemas, query the automation catalog:

```bash
curl -s http://127.0.0.1:3001/api/automation/catalog \
  | jq '.nodes[]
    | select(.typeId | startswith("hook:"))
    | {typeId, title, description, inputs, outputs}'
```

Use the `typeId` without the leading `hook:` as the Python `hook_id`.

Hook IDs and schemas are generated from the local server at runtime. Installed
plugins can add additional hook nodes, so the catalog endpoint is the source of
truth for a running Cloudx instance.

## Run Bash

`primitive:bash.exec` runs a bash script through
`bash --noprofile --norc -euo pipefail -c`. It is useful for direct shell work
that does not need Python logic.

Key inputs and limits mirror Python where possible:

- `Script`: bash source, capped at 100,000 characters.
- `STDIN`: optional UTF-8 text, capped at 1 MiB.
- `CWD`: optional working directory under allowed roots.
- `Timeout`: capped at 5 minutes and the remaining automation-run duration
  budget.
- `Parse JSON`: when enabled, stdout must be JSON and is exposed on the `JSON`
  output port.
- Captured stdout and stderr are capped at 1 MiB each.

Use the Python primitive when you need to call Cloudx hooks from code. Use the
Bash primitive when the graph only needs shell execution and process outputs.

## Implementation References

These behavior notes are grounded in:

- `apps/server/src/automation/AutomationCatalogService.ts`
- `apps/server/src/automation/AutomationExecutor.ts`
- `apps/server/src/hooks/HookRegistry.ts`
- `apps/server/src/hooks/coreHooks.ts`
- `apps/server/src/plugins/NotificationsPlugin.ts`
- `apps/server/src/automation/AutomationExecutor.test.ts`

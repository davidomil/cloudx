# CloudX documentation

CloudX brings project execution, review and research into a desktop
workspace. Start with a project window and add tools as you need them.
[Return to the repository README](../README.md).

## Use CloudX

| Guide                                  | What it covers                                              |
| -------------------------------------- | ----------------------------------------------------------- |
| [Setup](SETUP.md)                      | Install, update, configure services and develop locally.    |
| [Plugin catalog](plugins/README.md)    | All built-in tools, with setup steps and workflow diagrams. |
| [Demo workspaces](DEMO_WORKSPACES.md)  | Recreate desktop layouts and capture current screenshots.   |
| [Workspace workflows](WEB_APP_PLAN.md) | How windows, plugins and services fit a development task.   |
| [Security model](SECURITY_MODEL.md)    | Host access, allowed roots and private remote access.       |
| [Motivation](MOTIVATION.md)            | Why CloudX centers on continuity of production work.        |

Starting points.

## Go deeper

| Area                  | References                                                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation archive | [User guide](plugins/documentation.md), [archive internals](MEMORY_PLUGIN_GUIDE.md), [lifecycle](architecture/documentation-lifecycle.md), [schematics](architecture/documentation-schematics.md) |
| Automation            | [User guide](plugins/automation.md), [Python and Bash execution](AUTOMATION_CODE_EXECUTION.md), [catalog coverage](automation-catalog-coverage.md)                                                |
| Forge workers         | [User guide](plugins/forge.md), [implementation](implementation/forge-workers.md)                                                                                                                 |
| Architecture          | [System context](architecture/system-context.md), [ownership](architecture/module-ownership.md), [state invariants](architecture/state-invariants.md)                                             |
| Contributing          | [Contribution guide](../CONTRIBUTING.md), [testing map](architecture/testing-map.md), [optional managed automation](AI_CHANGE_PROCESS.md)                                                         |

Operational guides and engineering references.

[Release notes](releases/v0.1.3.md) and implementation plans describe
their recorded revision. Use the plugin guides and current source for
present behavior. [Launch copy](LAUNCH_COPY.md) contains current project
descriptions.

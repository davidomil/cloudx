# Motivation

Existing webpage-based Codex CLI systems tend to miss the real workflow. A useful system is not just a browser terminal. It needs to let a developer leave multiple Codex jobs running, check them from a laptop or phone, speak follow-up instructions when typing is inconvenient, and keep enough state to route those instructions to the right session.

The core problem is continuity. Codex jobs are long-running, contextual, and often parallel. A terminal window on one machine works until the developer walks away, switches devices, or wants to quickly dictate a correction. Web wrappers usually collapse the experience into a single brittle shell, with poor session awareness and no safe way for voice input to do anything more nuanced than paste text.

Cloudx is motivated by four requirements:

1. Remote visibility without public exposure.
   The first version should work over localhost, LAN, or Tailscale. It should show progress from phone and laptop without placing a powerful terminal service on the public internet.

2. A workspace model that matches real coding.
   Tabs should feel closer to tmux or an IDE than a chat app. Sessions need switching, rearranging, splitting, directory selection, and clear job status.

3. Plugins as the main extension point.
   A Codex terminal is only the first panel type. The system should be able to add a file browser, a normal terminal, logs, diff viewers, or other focused tools without rewriting the shell. Plugins need backend capabilities, frontend panels, action schemas, and voice-exposed commands.

4. Voice control that is capable but constrained.
   Dictation must understand the current tab, visible panes, recent terminal activity, and plugin actions. It should support chains such as opening a file and then editing it. But the voice controller must not have arbitrary process control. It should only emit structured actions exported by plugins, and the backend should validate every action before execution.

The long-term goal is a private developer cockpit: a small web app that can sit on a workstation, expose only what is needed to trusted devices, and let the developer supervise or steer multiple Codex sessions with minimal friction.

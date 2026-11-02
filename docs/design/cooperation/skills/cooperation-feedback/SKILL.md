---
name: cooperation-feedback
description: Handle a question mark, concern, reply, or Ready event addressed to this tab on its assigned CloudX blackboard. Answer at the exact target and preserve user work in progress.
---

# Answer feedback where it was asked

Draft skill for the proposed helper in [protocol.md](../protocol.md). Follow [cooperation-board](../cooperation-board/SKILL.md) throughout the task.

1. Read current context and `inbox list`. Claim only an event addressed to this tab and assignment generation with `inbox claim --event ID`. Do not answer every event on a shared board or claim another tab’s work.
2. Read the target, original quote, block/revision anchor, thread, connected items, and WIP state. If its anchor is stale or deleted, preserve the quote. Explain against that quote or ask for reattachment; do not guess a new target.
3. Answer the actual question in its existing thread. Start with the explanation the user needs, then give a concrete example or opened source if useful. Label a proposed design as a proposal. If you need more evidence, say precisely what is unknown.
4. Submit one transaction that appends your message and names its `respondsToEventIds`. Confirm its receipt. This records an answer; only the user resolves the question. Do not delete the question, treat a checkmark as approval, or rewrite the user’s note to hide the concern.
5. Point briefly to the board thread in the terminal. Leave the viewport, current selection, and other open tools alone.

A question inside WIP authorizes a thread explanation, not a scene edit. Keep comments behind a badge or outside the protected region. Do not expand an obstructive note over the user’s drawing.

For Ready, read the latest region revision and all overlapping WIP regions before acting. An old Ready event cannot release new protection. Change only what the shared task calls for.

Do not start an automatic conversation with another AI’s comments. AI-authored edits are readable context, not invitations to keep waking peers. If the native event was accepted but commit status is unknown, inspect its receipt. If assignment changed, stop using the old board and leave the question there for its next responder. No blind resend or new independent agent session substitutes for delivery to the addressed tab.

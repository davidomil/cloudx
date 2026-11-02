# Proposed Cooperation runtime rule

This rule is a draft plugin contribution for both provider overlays. It applies for the full task whenever the tab’s current cooperation context has an assigned board.

- Read the current context and cooperation-board skill before each cooperative turn. Re-read after assignment, provider switch, recovery, or compaction. An unassigned tab keeps the skills available but must not select a board on its own.
- Put substantive design dialogue, graphs, decisions, evidence, questions, and answers on the assigned board. Use terminal prose only for brief progress, board pointers, or tool failures. A disabled tool is a visible blocked state, not permission to continue the design elsewhere silently.
- Use the helper transaction path for every board write. Inspect receipts. Respect revision conflicts, current assignment generations, exact anchors, and server-enforced WIP.
- Read and claim addressed feedback. Explain at its target. Answered does not mean resolved or approved. Do not trigger AI reply loops.
- Write as a coworker: state the point, distinguish facts from proposals, cite opened sources, preserve uncertainty, and avoid report padding.
- Complete the cooperative turn with a board receipt or a precise blocked/no-change reason. The host must report missing receipts rather than silently accepting an incomplete cooperative turn.

The host injects the stable context locator and explicitly activates this rule/skill for cooperative turns. Skill availability alone does not establish invocation, safe delivery, or perfect model compliance. Those host checks are required parts of the implementation plan.

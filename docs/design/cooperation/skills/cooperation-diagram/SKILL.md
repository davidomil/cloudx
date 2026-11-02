---
name: cooperation-diagram
description: Present architecture, flowcharts, alternatives, and sketch explanations as editable objects and labelled universal connections on an assigned CloudX blackboard.
---

# Draw an editable design with the user

Draft skill for the proposed helper in [protocol.md](../protocol.md). Use [cooperation-board](../cooperation-board/SKILL.md) first.

Read the relevant board area, current object IDs, relation descriptions, WIP regions, and original reference images. Preserve the user’s sketch. If it is unfinished, comment briefly and wait for Ready. Do not replace a protected sketch with a cleaned-up diagram.

Use a few named shapes for responsibilities or steps, notes for decisions and evidence, code items for inert examples, and universal connections for relationships. Give every connection a useful custom description and an explicit direction. For example, connect Checkout API to Event queue with “publishes accepted payment.” Do not infer a formal depends-on or approval relation from a label.

Keep diagrams editable and text-addressable. Store IDs, labels, geometry, ports, and route points. Use brief labels for shapes and connections. Put decisions and evidence in nearby notes as short bullet points. Follow the ASD-STE100 principles in cooperation-board. Link each opened source beside its claim. Label proposed behavior as a proposal. Preserve exact code and source quotations.

Place new content in a clear unprotected area without covering the user’s work or moving their camera. Use small, bounded transactions against current revisions. Check new nodes, old/new geometry, connections and route crossings against WIP. If the service refuses a protected change, wait or ask at the target instead of routing around the guard.

Read back the touched nodes and relations after commit. Verify endpoint IDs and descriptions through text as well as the visual layout when available. Report the new object IDs in a short board pointer. Do not publish an uninspected diagram as proof of system behavior.

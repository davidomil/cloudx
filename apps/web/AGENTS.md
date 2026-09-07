# Web Context

The React app projects server/plugin state and owns local interaction state.
`src/api.ts` owns browser transport; `App.tsx` is composition and navigation.
Server authorization, path policy, automation safety, and process lifecycle stay
on the server.

- Reconcile local state when workspace IDs disappear. In-flight commands keep
  their original target ID; later selection changes must not retarget them.
- Clean up subscriptions, timers, sockets, terminal views, object URLs, audio,
  and stale async work with their owner.
- Use `@cloudx/shared` contracts. Transport changes can affect both `src/api.ts`
  and the server provider.
- Follow the existing Lucide icons and compact workbench conventions. Consider
  keyboard, touch, mobile, accessibility, loading, error, and reconnect states
  relevant to the changed interaction.

Use component or pure-state tests for logic. Check the browser when the claim
depends on actual interaction or rendering; choose viewports and screenshots
that demonstrate the change. A successful build alone does not prove UI behavior.

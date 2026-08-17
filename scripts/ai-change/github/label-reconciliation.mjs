import { repoRoute } from "./api.mjs";

export function labelDelta({ current, desired, manages }) {
  const currentSet = new Set(current);
  const desiredSet = new Set(desired);
  return {
    add: [...desiredSet].filter(
      (label) => manages(label) && !currentSet.has(label),
    ),
    remove: [...currentSet].filter(
      (label) => manages(label) && !desiredSet.has(label),
    ),
  };
}

export async function reconcileIssueLabels({
  api,
  number,
  current,
  desired,
  manages,
}) {
  const delta = labelDelta({ current, desired, manages });
  for (const label of delta.remove) {
    try {
      await api.delete(
        repoRoute(
          api.repository,
          `/issues/${number}/labels/${encodeURIComponent(label)}`,
        ),
      );
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  if (delta.add.length > 0) {
    await api.post(repoRoute(api.repository, `/issues/${number}/labels`), {
      labels: delta.add,
    });
  }
  return delta;
}

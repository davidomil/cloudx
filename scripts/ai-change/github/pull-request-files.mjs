import { repoRoute } from "./api.mjs";

export async function changedPathsForPullRequest(api, pullRequest) {
  const files = await changedFilesForPullRequest(api, pullRequest);
  return files.flatMap((file) => [
    file.filename,
    ...(file.previous_filename ? [file.previous_filename] : []),
  ]);
}

export async function changedFilesForPullRequest(api, pullRequest) {
  if (
    !Number.isInteger(pullRequest.changed_files) ||
    pullRequest.changed_files < 0
  ) {
    throw new Error(
      "Pull request must report a non-negative changed_files count.",
    );
  }
  if (pullRequest.changed_files >= 3_000) {
    throw new Error(
      "Pull request reaches GitHub's 3000-file response limit; complete path classification cannot be proven.",
    );
  }
  const files = await api.paginate(
    repoRoute(api.repository, `/pulls/${pullRequest.number}/files`),
  );
  if (files.length !== pullRequest.changed_files) {
    throw new Error(
      `GitHub returned ${files.length} of ${pullRequest.changed_files} changed files for pull request ${pullRequest.number}.`,
    );
  }
  return files;
}

import type {
  ForgeCreateChangeRequest,
  ForgeReviewSubmission,
} from "@cloudx/shared";
import { ForgeProviderError } from "./ForgeProvider.js";

export function validateCreateRequest(input: ForgeCreateChangeRequest): void {
  for (const value of [input.title, input.headBranch, input.baseBranch]) {
    if (
      typeof value !== "string" ||
      !value.trim() ||
      value.length > 255 ||
      /[\r\n\x00]/.test(value)
    )
      throw new ForgeProviderError(
        "Set a title, source branch, and target branch (at most 255 characters each).",
      );
  }
  if (typeof input.body !== "string" || input.body.length > 65_000)
    throw new ForgeProviderError(
      "Request descriptions must be at most 65,000 characters.",
    );
}

export function validateReview(input: ForgeReviewSubmission): void {
  if (
    !input ||
    !["comment", "approve", "request_changes"].includes(input.event) ||
    !/^[a-fA-F0-9]{40,64}$/.test(input.headSha)
  )
    throw new ForgeProviderError(
      "A review requires a valid action and commit SHA.",
    );
  if (
    typeof input.body !== "string" ||
    input.body.length > 65_000 ||
    !Array.isArray(input.comments) ||
    input.comments.length > 100
  )
    throw new ForgeProviderError(
      "A review supports at most 100 comments and a 65,000-character summary.",
    );
  if (
    input.event !== "approve" &&
    !input.body.trim() &&
    input.comments.length === 0
  )
    throw new ForgeProviderError("Write a review comment before submitting.");
  for (const comment of input.comments) {
    if (
      !comment ||
      typeof comment.body !== "string" ||
      !comment.body.trim() ||
      comment.body.length > 65_000
    )
      throw new ForgeProviderError(
        "Each review comment needs a body of at most 65,000 characters.",
      );
    if (comment.path !== undefined) {
      if (
        typeof comment.path !== "string" ||
        !comment.path ||
        comment.path.length > 4096 ||
        comment.path.startsWith("/") ||
        comment.path.split("/").includes("..") ||
        /[\r\n\x00]/.test(comment.path) ||
        !Number.isSafeInteger(comment.line) ||
        comment.line! < 1
      )
        throw new ForgeProviderError(
          "Inline comments require a relative file path and a positive line number.",
        );
      if (
        comment.oldPath !== undefined &&
        (typeof comment.oldPath !== "string" ||
          !comment.oldPath ||
          comment.oldPath.startsWith("/") ||
          comment.oldPath.split("/").includes(".."))
      )
        throw new ForgeProviderError("The old file path must be relative.");
      if (
        comment.side !== undefined &&
        !["LEFT", "RIGHT"].includes(comment.side)
      )
        throw new ForgeProviderError(
          "Choose the left or right side of the diff.",
        );
    } else if (
      comment.line !== undefined ||
      comment.side !== undefined ||
      comment.oldPath !== undefined
    )
      throw new ForgeProviderError("A line or diff side requires a file path.");
  }
}

"""Authorize local originals at the descriptor used for acquisition."""
from contextlib import contextmanager
import os
from pathlib import Path
import stat


def _resolve_original_path(path: Path) -> Path:
    from .archive import ArchiveError
    try:
        return path.resolve()
    except (OSError, RuntimeError, ValueError) as error:
        raise ArchiveError(f"Original source path cannot be resolved: {error}") from error


class LocalSourceAccess:
    def __init__(self, allowed_roots):
        from .archive import ArchiveError
        roots = [Path(root) for root in allowed_roots]
        if any(not root.is_absolute() for root in roots):
            raise ArchiveError("Configured source roots must be absolute paths.")
        self.roots = [_resolve_original_path(root) for root in roots]

    @contextmanager
    def open(self, candidate: Path):
        from .archive import ArchiveError
        descriptor = None
        try:
            resolved = _resolve_original_path(candidate)
            if not candidate.is_absolute() or not any(resolved.is_relative_to(root) for root in self.roots):
                raise ArchiveError("Original source is outside configured Cloudx roots.")
            # Walk from the filesystem anchor: O_NOFOLLOW on only the final
            # component would still allow an ancestor swapped for a symlink.
            descriptor = os.open(resolved.anchor, os.O_RDONLY | os.O_DIRECTORY)
            for index, component in enumerate(resolved.parts[1:]):
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                if index < len(resolved.parts) - 2:
                    flags |= os.O_DIRECTORY
                child = os.open(component, flags, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
            yield descriptor
        except OSError as error:
            raise ArchiveError(f"Original source acquisition failed: {error}") from error
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def read(self, descriptor: int, limit: int) -> bytes:
        from .archive import ArchiveError
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ArchiveError("Original source must be a regular file.")
        with os.fdopen(descriptor, "rb", closefd=False) as original:
            content = original.read(limit + 1)
        if len(content) > limit:
            raise ArchiveError("Original sources exceed the ingest size limit.")
        return content

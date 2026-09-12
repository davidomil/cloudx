import os
from pathlib import Path

import pytest

from cloudx_documentation_indexer.archive import ArchiveError
from cloudx_documentation_indexer.source_access import LocalSourceAccess


@pytest.mark.parametrize("replacement", ["file", "ancestor"])
def test_source_open_rejects_symlinks_swapped_after_authorization(tmp_path, monkeypatch, replacement):
    allowed = tmp_path / "allowed"
    folder = allowed / "folder"
    folder.mkdir(parents=True)
    original = folder / "source.txt"
    original.write_bytes(b"allowed content")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "source.txt").write_bytes(b"outside content")
    access = LocalSourceAccess([allowed])
    resolve = Path.resolve

    def replace_after_resolving(path, *args, **kwargs):
        resolved = resolve(path, *args, **kwargs)
        if path == original:
            if replacement == "file":
                original.unlink()
                original.symlink_to(outside / "source.txt")
            else:
                folder.rename(allowed / "previous")
                folder.symlink_to(outside, target_is_directory=True)
        return resolved

    monkeypatch.setattr(Path, "resolve", replace_after_resolving)
    with pytest.raises(ArchiveError, match="acquisition failed"):
        with access.open(original):
            pytest.fail("A replaced symlink must never be opened for reading")


@pytest.mark.parametrize("alias", ["file", "root"])
def test_allowed_symlinks_read_the_authorized_target(tmp_path, alias):
    root = tmp_path / "originals"
    root.mkdir()
    original = root / "source.txt"
    original.write_bytes(b"allowed content")
    link = tmp_path / "alias" if alias == "root" else root / "alias.txt"
    link.symlink_to(root if alias == "root" else original)
    access = LocalSourceAccess([link if alias == "root" else root])
    with access.open(link / "source.txt" if alias == "root" else link) as descriptor:
        assert access.read(descriptor, 15) == b"allowed content"
    with pytest.raises(OSError):
        os.fstat(descriptor)


@pytest.mark.parametrize("kind", ["directory", "fifo"])
def test_only_regular_files_can_supply_original_bytes(tmp_path, kind):
    source = tmp_path / "source"
    source.mkdir() if kind == "directory" else os.mkfifo(source)
    access = LocalSourceAccess([tmp_path])
    with pytest.raises(ArchiveError, match="regular file"):
        with access.open(source) as descriptor:
            access.read(descriptor, 10)
    with pytest.raises(OSError):
        os.fstat(descriptor)


def test_read_bounds_apply_to_opened_bytes_even_when_the_original_grows(tmp_path):
    source = tmp_path / "source.txt"
    source.write_bytes(b"old")
    access = LocalSourceAccess([tmp_path])
    with pytest.raises(ArchiveError, match="size limit"):
        with access.open(source) as descriptor:
            with source.open("ab") as writer:
                writer.write(b" more content")
            access.read(descriptor, 3)
    with pytest.raises(OSError):
        os.fstat(descriptor)


@pytest.mark.parametrize("allowed", ["empty", "sibling-prefix"])
def test_root_authorization_uses_path_components(tmp_path, allowed):
    root = tmp_path / "allowed"
    root.mkdir()
    sibling = tmp_path / "allowed-other"
    sibling.mkdir()
    source = sibling / "source.txt"
    source.write_bytes(b"outside")
    access = LocalSourceAccess([] if allowed == "empty" else [root])
    with pytest.raises(ArchiveError, match="outside configured.*roots"):
        with access.open(source):
            pytest.fail("Outside sources must be rejected before reading")

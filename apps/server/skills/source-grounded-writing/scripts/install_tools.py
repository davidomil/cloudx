#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import stat
import tarfile
import tempfile
import urllib.request
from pathlib import Path

from sgw_common import SKILL_DIR


TOOLS_DIR = SKILL_DIR / ".tools"
BIN_DIR = TOOLS_DIR / "bin"

QUARTO_VERSION = "1.9.38"
D2_VERSION = "0.7.1"
JRE_VERSION = "21.0.11_10"
PLANTUML_VERSION = "1.2026.5"


def arch_key() -> str:
    machine = os.uname().machine
    if machine in {"x86_64", "amd64"}:
        return "amd64"
    if machine in {"aarch64", "arm64"}:
        return "arm64"
    raise SystemExit(f"Unsupported architecture: {machine}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, expected_sha256: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and sha256(dest) == expected_sha256:
        return dest
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    print(f"Downloading {url}")
    with urllib.request.urlopen(url) as response, tmp.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    actual = sha256(tmp)
    if actual != expected_sha256:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"SHA256 mismatch for {url}: expected {expected_sha256}, got {actual}")
    tmp.replace(dest)
    return dest


def safe_extract(archive: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    dest_root = dest.resolve()
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            target = (dest / member.name).resolve()
            if not target.is_relative_to(dest_root):
                raise SystemExit(f"Refusing to extract path outside destination: {member.name}")
        tar.extractall(dest)


def link(src: Path, dest: Path) -> None:
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    dest.unlink(missing_ok=True)
    dest.symlink_to(src)


def ensure_executable(path: Path) -> None:
    mode = path.stat().st_mode
    path.chmod(mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def install_quarto() -> None:
    arch = arch_key()
    names = {
        "amd64": ("linux-amd64", "ea8c897368791ad9f200010c087ea3111b2e556b12a960487dd4e216902aa102"),
        "arm64": ("linux-arm64", "75fbc5c1121ffe65e564e9d24711db2ad8f617f9552f5dc7d8a06307d72dde38"),
    }
    platform, checksum = names[arch]
    archive = download(
        f"https://github.com/quarto-dev/quarto-cli/releases/download/v{QUARTO_VERSION}/quarto-{QUARTO_VERSION}-{platform}.tar.gz",
        checksum,
        TOOLS_DIR / "downloads" / f"quarto-{QUARTO_VERSION}-{platform}.tar.gz",
    )
    root = TOOLS_DIR / f"quarto-{QUARTO_VERSION}"
    if not (root / "bin" / "quarto").exists():
        safe_extract(archive, TOOLS_DIR)
    link(root / "bin" / "quarto", BIN_DIR / "quarto")
    print(f"Installed Quarto {QUARTO_VERSION}")


def install_d2() -> None:
    arch = arch_key()
    checksums = {
        "amd64": "eb172adf59f38d1e5a70ab177591356754ffaf9bebb84e0ca8b767dfb421dad7",
        "arm64": "ce3a0b985a8f91335a826c254b3a88736fd81afcdd08b58f6c749d2add6864b0",
    }
    archive = download(
        f"https://github.com/terrastruct/d2/releases/download/v{D2_VERSION}/d2-v{D2_VERSION}-linux-{arch}.tar.gz",
        checksums[arch],
        TOOLS_DIR / "downloads" / f"d2-v{D2_VERSION}-linux-{arch}.tar.gz",
    )
    root = TOOLS_DIR / f"d2-{D2_VERSION}"
    if not root.exists():
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp = Path(tmp_dir)
            safe_extract(archive, tmp)
            root.mkdir(parents=True, exist_ok=True)
            for child in tmp.iterdir():
                shutil.move(str(child), root / child.name)
    candidates = [path for path in root.rglob("d2") if path.is_file()]
    if not candidates:
        raise SystemExit("D2 archive did not contain a d2 executable")
    ensure_executable(candidates[0])
    link(candidates[0], BIN_DIR / "d2")
    print(f"Installed D2 {D2_VERSION}")


def install_jre() -> None:
    arch = arch_key()
    names = {
        "amd64": (
            "x64",
            "e5038aae3ca9ff670bc696496b0728dbd23d280026bad30291cb919221ecfdcb",
        ),
        "arm64": (
            "aarch64",
            "fa23d9d9945053e67bcc7638410eabf1e17a7672c7c95a24f70cd08b8407d36e",
        ),
    }
    platform, checksum = names[arch]
    filename = f"OpenJDK21U-jre_{platform}_linux_hotspot_{JRE_VERSION}.tar.gz"
    archive = download(
        f"https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.11%2B10/{filename}",
        checksum,
        TOOLS_DIR / "downloads" / filename,
    )
    root = TOOLS_DIR / f"temurin-jre-{JRE_VERSION}"
    if not root.exists():
        safe_extract(archive, TOOLS_DIR)
        extracted = next(path for path in TOOLS_DIR.iterdir() if path.is_dir() and path.name.startswith("jdk-21.0.11+10-jre"))
        extracted.rename(root)
    java = root / "bin" / "java"
    ensure_executable(java)
    link(java, BIN_DIR / "java")
    print(f"Installed Temurin JRE {JRE_VERSION}")


def install_plantuml() -> None:
    jar = download(
        f"https://github.com/plantuml/plantuml/releases/download/v{PLANTUML_VERSION}/plantuml.jar",
        "de65ffc34b5c7fdad4e86309ce2dcceff98778799ae17b93a8f492d7a69080e1",
        TOOLS_DIR / "plantuml" / "plantuml.jar",
    )
    wrapper = BIN_DIR / "plantuml"
    wrapper.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "ROOT=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")/..\" && pwd)\"\n"
        "exec \"$ROOT/bin/java\" -jar \"$ROOT/plantuml/plantuml.jar\" \"$@\"\n",
        encoding="utf-8",
    )
    ensure_executable(wrapper)
    print(f"Installed PlantUML {PLANTUML_VERSION} at {jar}")


def install_dot_wrapper() -> None:
    wrapper = BIN_DIR / "dot"
    wrapper.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "ROOT=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")/..\" && pwd)\"\n"
        "SKILL_DIR=\"$(cd \"$ROOT/..\" && pwd)\"\n"
        "exec node \"$SKILL_DIR/scripts/dot_wrapper.mjs\" \"$@\"\n",
        encoding="utf-8",
    )
    ensure_executable(wrapper)
    print("Installed Graphviz DOT wrapper")


def main() -> int:
    parser = argparse.ArgumentParser(description="Install local binary tools for the Source Grounded Writing skill.")
    parser.add_argument("tools", nargs="+", choices=["all", "quarto", "d2", "jre", "plantuml", "dot-wrapper"])
    args = parser.parse_args()

    selected = {"quarto", "d2", "jre", "plantuml", "dot-wrapper"} if "all" in args.tools else set(args.tools)
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    BIN_DIR.mkdir(parents=True, exist_ok=True)

    if "quarto" in selected:
        install_quarto()
    if "d2" in selected:
        install_d2()
    if "jre" in selected:
        install_jre()
    if "plantuml" in selected:
        if "jre" not in selected and not (BIN_DIR / "java").exists():
            raise SystemExit("PlantUML requires Java. Run `python3 scripts/install_tools.py jre plantuml`.")
        install_plantuml()
    if "dot-wrapper" in selected:
        install_dot_wrapper()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

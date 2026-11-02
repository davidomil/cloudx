#!/usr/bin/env python3
"""Build/check the Claude reference inventory from retained original HTML.

Pass original settings-reference, env-vars and cli-reference files from the
documentation archive. This tool does not fetch, install or execute Claude.
New reference bytes require a deliberate catalog review and --write.
"""

import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re


class Reference(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.tables = []
        self.sections = {}
        self.table = self.row = self.cell = None
        self.section = None
        self.heading = None
        self.heading_id = None
        self.skip = 0
        self.feed(source)

    def handle_starttag(self, tag, attributes):
        if tag in ("script", "style"):
            self.skip += 1
        if self.skip:
            return
        attributes = dict(attributes)
        if tag == "table":
            self.table = []
        elif tag == "tr":
            self.row = []
        elif tag in ("td", "th"):
            self.cell = []
        elif tag in ("h2", "h3"):
            self.section = {"text": [], "id": attributes.get("id", "")}
            self.heading = []
            self.heading_id = attributes.get("id", "")

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.skip -= 1
            return
        if self.skip:
            return
        if tag in ("td", "th") and self.cell is not None:
            self.row.append(" ".join("".join(self.cell).split()))
            self.cell = None
        elif tag == "tr" and self.row is not None and self.table is not None:
            self.table.append(self.row)
            self.row = None
        elif tag == "table" and self.table is not None:
            self.tables.append(self.table)
            self.table = None
        elif tag in ("h2", "h3") and self.heading is not None:
            name = "".join(self.heading).strip("\u200b \n")
            self.sections[name] = self.section
            self.heading = None
        if self.section is not None and tag in ("li", "p", "h2", "h3"):
            self.section["text"].append("\n")

    def handle_data(self, text):
        if self.skip:
            return
        if self.cell is not None:
            self.cell.append(text)
        if self.heading is not None:
            self.heading.append(text)
        if self.section is not None:
            self.section["text"].append(text)


def lifecycle(text):
    beginning = text[:600].lower()
    if re.search(r"\bremoved (?:in|as of)\b", beginning):
        return "removed"
    if re.search(r"\bdeprecated\b", beginning):
        return "deprecated"
    return "documented"


def minimum_version(text):
    match = re.search(r"(?:Requires Claude Code|Added in) v?(\d+\.\d+\.\d+)", text)
    return match.group(1) if match else None


def setting_metadata(section):
    text = "".join(section.get("text", []))
    normalized = " ".join(text.split())
    native_type = re.search(r"Type\s*:\s*(Boolean|boolean|integer|number|string|array|object)", normalized)
    default = re.search(r"(?:^|\n)Default\s*:\s*([^\n]+)", text)
    default_text = default.group(1).strip() if default else ""
    literal = re.match(r'^(true|false|-?\d+(?:\.\d+)?|"[^"\n]*")(?=$|[,. ]\s*)', default_text)
    native_default = None
    default_kind = "unresolved"
    if default_text.lower().startswith("unset"):
        default_kind = "unset"
    elif literal:
        native_default = json.loads(literal.group(1))
        # Conditional defaults must not be flattened into an unconditional value.
        if re.search(r"\b(?:or|when|except|depending|otherwise|on Windows|on macOS)\b", default_text):
            default_kind = "conditional"
            native_default = None
        else:
            default_kind = "literal"
    return {"type": native_type.group(1).lower() if native_type else "unresolved",
            "defaultKind": default_kind, "nativeDefault": native_default,
            "minimumVersion": minimum_version(normalized.split("Scope", 1)[0]),
            "versionMentions": list(dict.fromkeys(re.findall(r"\bv?(\d+\.\d+\.\d+)\b", normalized))),
            "lifecycle": lifecycle(normalized)}


def build_inventory(sources):
    entries = []
    evidence = []
    for family, source in sources.items():
        content = source.read_bytes()
        reference = Reference(content.decode("utf-8"))
        source_id = len(evidence)
        evidence.append({"family": family, "url": "https://code.claude.com/docs/en/" + {"settings": "settings-reference", "environment": "env-vars", "cli": "cli-reference"}[family],
                         "sha256": hashlib.sha256(content).hexdigest()})
        for table in reference.tables:
            if not table:
                continue
            if family == "settings" and table[0] == ["Key", "Description", "Topic", "Scope"]:
                for name, _, topic, scope in table[1:]:
                    section = reference.sections.get(name, {})
                    entries.append({"family": family, "name": name, "topic": topic, "scope": scope,
                                    "source": source_id, "anchor": section.get("id", name.lower().replace(".", "-")), **setting_metadata(section)})
            elif family == "environment" and table[0][0] == "Variable":
                for row in table[1:]:
                    name, text = row[:2]
                    entries.append({"family": family, "name": name, "topic": "Environment", "scope": "Launch environment or native settings env",
                                    "source": source_id, "anchor": "variables", "type": "string", "defaultKind": "unresolved", "nativeDefault": None,
                                    "minimumVersion": minimum_version(text.split(". ", 1)[0]),
                                    "versionMentions": list(dict.fromkeys(re.findall(r"\bv?(\d+\.\d+\.\d+)\b", text))), "lifecycle": lifecycle(text)})
            elif family == "cli" and table[0][0] in ("Command", "Flag"):
                for row in table[1:]:
                    name, text = row[:2]
                    entries.append({"family": family, "name": name, "topic": "CLI commands" if table[0][0] == "Command" else "CLI flags",
                                    "scope": "Native session or command", "source": source_id, "anchor": "cli-commands" if table[0][0] == "Command" else "cli-flags",
                                    "type": "command", "defaultKind": "unresolved", "nativeDefault": None,
                                    "minimumVersion": minimum_version(text.split(". ", 1)[0]),
                                    "versionMentions": list(dict.fromkeys(re.findall(r"\bv?(\d+\.\d+\.\d+)\b", text))), "lifecycle": lifecycle(text)})
    # CLI's system-prompt summary repeats flag rows; keep its main flag table.
    unique = {}
    for entry in entries:
        key = (entry["family"], entry["name"])
        if key in unique:
            unique[key]["referenceRows"] += 1
        else:
            unique[key] = {**entry, "referenceRows": 1}
    return {"schemaVersion": 1, "reviewedAt": "2026-11-01", "referenceSnapshotDate": "2026-10-30",
            "verifiedNativeVersions": [], "sources": evidence,
            "entries": sorted(unique.values(), key=lambda entry: (entry["family"], entry["name"]))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for family in ("settings", "environment", "cli"):
        parser.add_argument("--" + family, required=True, type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[2] / "packages/shared/src/claudeConfigurationInventory.json")
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    inventory = build_inventory({family: getattr(args, family) for family in ("settings", "environment", "cli")})
    if not all(any(entry["family"] == family for entry in inventory["entries"]) for family in ("settings", "environment", "cli")):
        raise SystemExit("Incomplete Claude reference: expected settings, environment and CLI tables.")
    metadata = {key: value for key, value in inventory.items() if key != "entries"}
    text = json.dumps(metadata, indent=2, ensure_ascii=False)[:-2] + ',\n  "entries": [\n'
    text += ",\n".join("    " + json.dumps(entry, ensure_ascii=False) for entry in inventory["entries"])
    text += "\n  ]\n}\n"
    if args.write:
        args.output.write_text(text)
    elif not args.output.exists() or args.output.read_text() != text:
        raise SystemExit("Claude reference drift: review changed entries, scope, types, defaults and source provenance before updating the checked inventory with --write.")
    counts = {family: sum(entry["family"] == family for entry in inventory["entries"]) for family in ("settings", "environment", "cli")}
    print(json.dumps(counts, sort_keys=True))


if __name__ == "__main__":
    main()

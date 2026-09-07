"""Insert the compiled current revision before the earlier delivery history."""
from pathlib import Path
import sys

plan_path = Path(__file__).resolve().parent.parent / "forge-workers-plan.md"
revision = Path(sys.argv[1]).read_text()
if revision.startswith("---\n"):
    revision = revision.split("\n---\n", 1)[1].lstrip()
assert revision.startswith("## Current revision:")
plan = plan_path.read_text()
history = plan.index("## Research and evidence")
current = plan.find("## Current revision:")
prefix = plan[:current if current >= 0 else history].rstrip()
plan_path.write_text(f"{prefix}\n\n{revision.rstrip()}\n\n{plan[history:]}")
print("Packaged docs/implementation/forge-workers-plan.md")

"""Package the compiled guide with a Markdown heading and its audited visual."""
from pathlib import Path
import json

artifact_dir = Path(__file__).resolve().parent
markdown_path = artifact_dir.parent / 'forge-workers.md'
ir = json.loads((artifact_dir / 'forge-workers.ir.json').read_text())
markdown = markdown_path.read_text()
if markdown.startswith('---\n'):
    markdown = markdown.split('\n---\n', 1)[1].lstrip()
markdown = markdown.replace('src="assets/generated/issue-flow.png" style="width:100.0%"', 'src="forge-workers-audit/assets/generated/issue-flow.png" width="420"')
markdown_path.write_text(f"# {ir['title']}\n\n{markdown}")
copy = artifact_dir.parent / 'assets/generated/issue-flow.png'
copy.unlink(missing_ok=True)
for directory in [copy.parent, copy.parent.parent]:
    if directory.is_dir() and not any(directory.iterdir()):
        directory.rmdir()
assert (artifact_dir / 'assets/generated/issue-flow.png').is_file()
assert markdown_path.read_text().startswith('# Forge Workers\n')
print('Packaged docs/implementation/forge-workers.md')

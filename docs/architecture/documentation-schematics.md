---
title: Documentation schematic analysis and operator setup
format:
  html:
    toc: true
    number-sections: true
  docx:
    toc: true
  gfm:
    variant: +yaml_metadata_block
---

## Analysis contract

Schematic imports retain source geometry and typed component, terminal,
net, port and text evidence. Page artifacts use schema version 2. Each
schematic page entry exposes a terminal-graph output; documents with
several schematic pages also expose a document-terminal-graph output.
Source hashes, page bounds and image dimensions preserve the coordinate
transform.

Native PDF analysis requires electrical symbol shapes with external wire
contacts. Plot identifiers and package dimensions alone do not establish
a schematic. Anonymous rectangular bodies need consistent numeric pin
evidence. A raster-only PDF page or image is analyzed when its filename
explicitly contains schematic or circuit and its bitmap contains
line-art edges. Automatic classification of arbitrary scanned PDFs
remains unsupported; generic source figures and text remain available.

Native vector geometry, local OCR and SINA detection have separate
capability outcomes. supported means that a particular stage ran
successfully. blocked records a missing asset, runtime failure, timeout
or work limit. unresolved marks uncertain electrical interpretation.
Automatic circuit and document graphs remain unresolved and include
their issues; successful detection does not establish complete pin, net
or device-model correctness.

## Provision the optional SINA detector

The validated worker runs locally on Linux with CPU execution. Provision
the schematic extra explicitly from the repository root before
configuring a checkpoint. It pins Ultralytics 8.3.162, torch 2.13.0 and
torchvision 0.28.0. The lock selects the explicit PyTorch CPU index for
Linux; use the project environment so an unrelated CUDA torchvision
wheel cannot replace the matching CPU build. The runtime probe below
checks the NMS operator used by detection. This follows the official [uv
PyTorch index
configuration](https://docs.astral.sh/uv/guides/integration/pytorch/).

```bash
uv sync --project services/documentation-indexer --locked --extra schematic
services/documentation-indexer/.venv/bin/python - <<'PYTHON'
import torch, torchvision
from torchvision.ops import nms
print(torch.__version__, torchvision.__version__)
print(nms(torch.empty((0, 4)), torch.empty((0,)), 0.5))
PYTHON
```

Obtain a trusted checkpoint separately from the [SINA project referenced
by its paper](https://arxiv.org/html/2601.22114v1), store it at a stable
absolute path, and verify its digest before enabling it. No checkpoints
are bundled with CloudX. The tested IC last.pt checkpoint is 40,517,349
bytes with SHA-256
15ebad810d95c7df3eb92e1e5c4937fcc6034ab15dd6b0f4a2cf6ce06f441cc5. This
digest identifies the inspected local bundle; it is not a signed
publisher attestation. Loading a PyTorch checkpoint invokes its
deserializer, so the path must refer to a trusted operator-provisioned
asset.

```bash
export CLOUDX_SINA_MODEL_PATH=/opt/cloudx-models/sina-ic-last.pt
export CLOUDX_SINA_MODEL_SHA256=15ebad810d95c7df3eb92e1e5c4937fcc6034ab15dd6b0f4a2cf6ce06f441cc5
export CLOUDX_SINA_TIMEOUT_SECONDS=45
export CLOUDX_SINA_IMAGE_SIZE=640
sha256sum "$CLOUDX_SINA_MODEL_PATH"
```

The inspected SINA source license is MIT, copyright 2025 MEDAL Research
Group. Its checkpoint metadata separately states AGPL-3.0 and links to
[Ultralytics licensing](https://www.ultralytics.com/license). Review the
checkpoint and dependency terms for the intended use; the source license
does not establish model redistribution permission.

## Provision local OCR for outlined labels

OCR is an independent optional capability. It uses an explicitly
configured Tesseract 5 executable and one named .traineddata asset. The
verified Ubuntu 24.04 setup extracted the following packages into a
private directory; it did not install host-wide packages. This procedure
relies on the existing Ubuntu base runtime libraries. Keep that
directory stable for the indexer process and verify the executable
before configuring it.

```bash
export SCHEMATIC_OCR_ROOT="$HOME/.local/share/cloudx/schematic-ocr"
mkdir -p "$SCHEMATIC_OCR_ROOT/packages"
cd "$SCHEMATIC_OCR_ROOT/packages"
apt-get download tesseract-ocr=5.3.4-1build5 tesseract-ocr-eng=1:4.1.0-2 libtesseract5=5.3.4-1build5 liblept5=1.82.0-3build4
for package in ./*.deb; do dpkg-deb -x "$package" "$SCHEMATIC_OCR_ROOT"; done
export LD_LIBRARY_PATH="$SCHEMATIC_OCR_ROOT/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export CLOUDX_SCHEMATIC_OCR_EXECUTABLE="$SCHEMATIC_OCR_ROOT/usr/bin/tesseract"
export CLOUDX_SCHEMATIC_OCR_MODEL_PATH="$SCHEMATIC_OCR_ROOT/usr/share/tesseract-ocr/5/tessdata/eng.traineddata"
export CLOUDX_SCHEMATIC_OCR_MODEL_SHA256=7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2
export CLOUDX_SCHEMATIC_OCR_TIMEOUT_SECONDS=45
"$CLOUDX_SCHEMATIC_OCR_EXECUTABLE" --version
sha256sum "$CLOUDX_SCHEMATIC_OCR_MODEL_PATH"
```

Pass the configured environment to the documentation-indexer service and
restart that process after changes. Each extraction pipeline reads its
settings once. OCR uses LSTM engine mode 1, sparse-text mode 11 and
bounded scaling up to 3×. It retains source bounding boxes and
confidence for each word, plus engine version, language, executable
digest and model digest. A separate native-body header pass records
local-body-label-ocr. OCR text is candidate evidence; geometry and
ambiguity checks still govern assignment. See the official [Tesseract
command-line
documentation](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html).

## Bounds and electrical interpretation

Native classification is bounded at 30,000 vector objects and 100,000
characters per page. If this initial native pass exceeds its bound, the
PDF retains normal source and figure extraction but may have no
schematic classification or graph artifact. A later wire-connectivity
limit on an admitted schematic records a blocked graph capability. These
are distinct outcomes.

SINA uses one private worker per document, started only when an image
needs detection. Sequential image calls reuse the model with four CPU
threads, default input size 640, confidence threshold 0.25 and at most
512 detections. Each call has a timeout of 45 seconds by default,
configurable from 1–300 seconds. A document allows 64 images, 25 million
pixels per image, 256 million total pixels and at most 300 seconds. Each
image file and output is removed after its reply. A failed scope closes
without restarting; document exit kills and reaps its worker. The worker
verifies the model digest and runtime, disables automatic downloads and
dependency installation, and rejects invalid provenance or oversized
output. OCR accepts 1–120 seconds per invocation, at most 25 million
image pixels and bounded TSV output. Missing or failed requested
capabilities are recorded explicitly; independently available native
evidence remains usable.

Connectivity retains dangling contacts and singleton external nets.
Undotted interior crossings remain separate; explicit junctions and
shared endpoints join. Raster corners and tees join only when the
foreground pixels support their connecting arms. The raster path handles
black, blue, red and green line candidates without joining a background
label or closing real gaps. Raster diagonal wires, incomplete text
masking and ambiguous shapes remain unresolved. On native PDFs,
detector-only boxes are retained as candidates and cannot cut native
wires or establish terminal identity.

Cross-sheet joins require an explicit target-sheet filename, one
matching sheet instance and unique declared port names. The binding must
stay within the same source design. Equal text on unrelated sheets does
not join nets. Missing, repeated or ambiguous instances remain
unresolved. Automatic full-board SPICE export is unavailable. The export
helper accepts only an explicitly supported circuit containing
identified two-terminal R/C/L parts with source values and unique
references. Unsupported devices, ambiguous values and unresolved graphs
raise an error without emitting placeholders.

CLOUDX_SINA_IMAGE_SIZE explicitly selects 320, 640, 960 or 1280. The
configured value is verified in the worker request and output and
recorded in capability parameters. CLOUDX_SINA_TILE_SIZE selects
whole-image inference (0, the default) or fixed 1536-pixel regions with
256-pixel overlap. It does not automatically retry or change settings
for individual images.

## Measured coverage

Independent checks on the retained TI LM358 Figure 8-4 recover three
resistors, the op-amp contacts and ground, five exact electrical nets
and the external VIN contact at three render scales. The same expected
circuit is preserved inside full page 29. Arduino R4 LED-sheet checks
validate all 96 diode polarities, eleven 330-ohm resistors, 22 exact
nets and 214 terminal incidences. All eleven explicit parent/child ports
reach the expected resistor input. Board checks recover unique numeric
identities for R3 U3 pins 1–33, R3 U2 pins 1–5 and R4 U1 pins 1–64.
These are scoped electrical assertions, not verification of every
component, model or net on either board.

Detector false positives and unresolved body names remain visible in the
graph. Native whole-PDF extraction requires no configured SINA or OCR
assets; enabling them adds separate runtime cost and evidence. The
complete retained TI PDF has 68 pages, of which pages 24, 27 and 29 meet
the circuit criteria. Tests also retain the R3 board and both R4
schematic sheets while rejecting the inspected chart, table, prose and
mechanical examples.

A controlled five-image comparison retained exactly the same detector
classes, bounding boxes and confidence values while reducing mean
runtime from 10.210 seconds to 2.887 seconds. The inputs were the TI
amplifier crop, TI page 29, the R3 board and both R4 sheets. This
measures document-scoped detector reuse, not end-to-end archive speed.

Resolution changes alter symbol coverage. On the R4 LED sheet,
class-aware one-to-one matching against 107 source-native symbol boxes
found 37 matches at 640 and 96 at 960 using intersection-over-union
≥0.25. At the stricter 0.5 threshold, matches were 24 and 77. The
corresponding calls after startup took 0.218 and 0.319 seconds. These
are scoped symbol-box observations, not electrical fault-detection
accuracy. The TI crop retained all five expected symbols at both sizes.

## Dense native PDF settings

The GOOB export benefits from explicit 960-pixel detector input and
1536-pixel source regions. Tile overlap is 256 pixels. Same-class
overlaps above intersection-over-union 0.5 retain the most confident
original box and its source window. The worker allows at most 256
regions and 512 million processed region pixels per document, in
addition to the original image, pixel and time limits. More than 4096
unmerged candidates or 512 merged candidates on one image blocks
detection. It does not silently truncate the merged result.

For native PDFs with readable positioned text, uncovered-regions OCR
processes embedded bitmaps and unnamed native body headers. Embedded
image regions render directly from the PDF at scale 4 and use OCR
without further enlargement; other header crops keep bounded scaling up
to 3×. Every recognized word retains confidence and page-image
coordinates. Embedded reference-image words become searchable
observations, but cannot assign component or pin identities. This policy
does not cover arbitrary outlined text elsewhere on the page. Full-page
remains the default OCR policy, and raster-only input always uses
full-image OCR.

```bash
export CLOUDX_SINA_IMAGE_SIZE=960
export CLOUDX_SINA_TILE_SIZE=1536
export CLOUDX_SCHEMATIC_OCR_MODE=uncovered-regions
```

Use those settings with the explicitly provisioned SINA and OCR assets
above, then restart the indexer before ingest or reanalysis.
Rendering-mode capture excludes invisible PDF text from visible
electrical labels while retaining the hidden text in a separate source
layer. Color boundaries keep overlapping red net names and black pin
digits separate. Source character order is restored without quadratic
duplicate lookups.

The worker passes an explicit CPU device to the pinned Ultralytics
runtime and checks that Torch retains four threads after inference. In
the measured GOOB run, passing the string cpu reset Torch to eight
threads and the worker was killed on page 35 under its 300 CPU-second
cap. The corrected integrated run completes all 31 admitted schematic
pages with 225.07 CPU seconds and 124.82 seconds of worker lifetime,
within the unchanged limits.

## Exported PDF declarations

Recognized Altium literal metadata produces a separate
source-declarations artifact with schema version 1. It retains
physical-page and sheet scope, component references, pin tokens,
named-net memberships, PDF object identifiers and unassigned
component-property menus. This reads literal data without executing
JavaScript. It does not infer symbol bounds from bookmark zoom
rectangles or equate exported net names with observed wire connectivity.
Unsupported metadata is not synthesized; malformed input, coverage gaps
and budgets have explicit outcomes.

The unchanged 37-page GOOB export provides 1348 component identities,
4495 pins, 1566 scoped nets and 1441 property menus. Physical pages
15–17 each contain 31 menus but no component outlines. Those three
coverage gaps remain unresolved; repeated-sheet data is not copied into
them. Drawing labels and declarations disagree for some magnetometer
supply branches, so a full-board electrical netlist still requires
independent verification.

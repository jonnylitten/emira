#!/usr/bin/env bash
# Installs the OmniParser detector for emira.
#
# This is the heavy path: clones microsoft/OmniParser, creates a Python venv,
# installs torch + transformers + ultralytics + paddleocr, downloads ~1GB of
# model weights. Expect 15–60 minutes depending on bandwidth + GPU/CPU.
#
# Usage:
#   bash scripts/setup-omniparser.sh           # full setup
#   bash scripts/setup-omniparser.sh --stub    # just create venv + Pillow,
#                                              # no OmniParser. For protocol
#                                              # smoke-testing with the stub.
#
# After running, set:
#   export EMIRA_DETECTOR=omniparser
#   export EMIRA_OMNIPARSER_PATH="$PWD/omniparser/OmniParser"
# Then start the emira server normally — the Python sidecar is spawned
# lazily on first detection.

set -euo pipefail
cd "$(dirname "$0")/.."

STUB_ONLY=0
if [[ "${1:-}" == "--stub" ]]; then
  STUB_ONLY=1
fi

VENV_DIR="omniparser/.venv"
REPO_DIR="omniparser/OmniParser"

# OmniParser targets Python 3.12; 3.9 (macOS system Python) under-constrains
# pip's resolver enough that it times out on the dep graph. Prefer the newest
# available 3.12 / 3.11; refuse to run on 3.9 even if it's the only one.
if [[ -n "${PYTHON_BIN:-}" ]]; then
  : # honor user override
elif command -v python3.12 >/dev/null 2>&1; then
  PYTHON_BIN="python3.12"
elif command -v python3.11 >/dev/null 2>&1; then
  PYTHON_BIN="python3.11"
elif command -v python3.10 >/dev/null 2>&1; then
  PYTHON_BIN="python3.10"
else
  echo "Python 3.10+ not found. Install Python 3.12:" >&2
  echo "  brew install python@3.12" >&2
  echo "Then rerun this script. (Override with PYTHON_BIN=/path/to/python.)" >&2
  exit 1
fi

PY_VERSION=$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
PY_MAJOR=$("$PYTHON_BIN" -c 'import sys; print(sys.version_info[0])')
PY_MINOR=$("$PYTHON_BIN" -c 'import sys; print(sys.version_info[1])')
if [[ "$PY_MAJOR" -lt 3 || ( "$PY_MAJOR" -eq 3 && "$PY_MINOR" -lt 10 ) ]]; then
  echo "Python $PY_VERSION is too old. OmniParser needs 3.10+; 3.12 recommended." >&2
  exit 1
fi
echo "==> Using $PYTHON_BIN ($PY_VERSION)"

if [[ -d "$VENV_DIR" ]]; then
  EXISTING_VER=$("$VENV_DIR/bin/python" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "unknown")
  if [[ "$EXISTING_VER" != "$PY_VERSION" ]]; then
    echo "==> Existing venv uses Python $EXISTING_VER, recreating with $PY_VERSION"
    rm -rf "$VENV_DIR"
  fi
fi

echo "==> Creating venv at $VENV_DIR"
"$PYTHON_BIN" -m venv "$VENV_DIR"
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "==> Upgrading pip"
pip install --upgrade pip wheel

echo "==> Installing emira/omniparser/requirements.txt"
pip install -r omniparser/requirements.txt

if [[ "$STUB_ONLY" -eq 1 ]]; then
  cat <<EOF

Stub-mode setup complete. To smoke test the sidecar protocol:
  export EMIRA_OMNI_STUB=1
  export EMIRA_DETECTOR=omniparser
  npm run build && node dist/http-server.js

The stub returns one placeholder element per screenshot, which is enough to
exercise the Node↔Python plumbing without downloading weights.

To install the real OmniParser later, rerun this script without --stub.
EOF
  exit 0
fi

echo "==> Cloning microsoft/OmniParser"
if [[ ! -d "$REPO_DIR" ]]; then
  git clone https://github.com/microsoft/OmniParser.git "$REPO_DIR"
else
  echo "    already present, skipping clone"
fi

echo "==> Patching OmniParser repo for minimal-deps inference"
# OmniParser's util/utils.py eagerly imports PaddleOCR at module level and
# instantiates it as a global, even though it's only used when
# use_paddleocr=True. We route through easyocr, so neutralize both lines so
# we don't have to install paddlepaddle (~400MB).
UTILS_FILE="$REPO_DIR/util/utils.py"
if [[ -f "$UTILS_FILE" ]] && ! grep -q "emira: lazy via use_paddleocr=False" "$UTILS_FILE"; then
  python3 - "$UTILS_FILE" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
src = p.read_text()

# Patch 1: skip eager PaddleOCR import (we route through easyocr).
src = src.replace(
    "from paddleocr import PaddleOCR",
    "# from paddleocr import PaddleOCR  # emira: lazy via use_paddleocr=False",
)
old_block = """paddle_ocr = PaddleOCR(
    lang='en',  # other lang also available
    use_angle_cls=False,
    use_gpu=False,  # using cuda will conflict with pytorch in the same process
    show_log=False,
    max_batch_size=1024,
    use_dilation=True,  # improves accuracy
    det_db_score_mode='slow',  # improves accuracy
    rec_batch_num=1024)"""
src = src.replace(
    old_block,
    "paddle_ocr = None  # emira: PaddleOCR is unused (use_paddleocr=False routes to easyocr)",
)

# Patch 2: get_som_labeled_img crashes with TypeError when OCR finds no text
# (zip(None, ocr_text) blows up). Treat empty as empty rather than None.
src = src.replace(
    """    else:
        print('no ocr bbox!!!')
        ocr_bbox = None

    ocr_bbox_elem = [{'type': 'text', 'bbox':box, 'interactivity':False, 'content':txt, 'source': 'box_ocr_content_ocr'} for box, txt in zip(ocr_bbox, ocr_text) if int_box_area(box, w, h) > 0] """,
    """    else:
        print('no ocr bbox!!!')
        ocr_bbox = []  # emira: was None — caused TypeError in zip below on text-sparse pages

    ocr_bbox_elem = [{'type': 'text', 'bbox':box, 'interactivity':False, 'content':txt, 'source': 'box_ocr_content_ocr'} for box, txt in zip(ocr_bbox or [], ocr_text or []) if int_box_area(box, w, h) > 0]""",
)

# Patch 3: short-circuit when nothing was detected at all (both YOLO and OCR
# came back empty — e.g., a map tile with no UI). The rest of the function
# crashes on box_convert with a shape-[0] tensor; return an empty result.
src = src.replace(
    """    filtered_boxes_elem = sorted(filtered_boxes, key=lambda x: x['content'] is None)
    # get the index of the first 'content': None
    starting_idx = next((i for i, box in enumerate(filtered_boxes_elem) if box['content'] is None), -1)""",
    """    filtered_boxes_elem = sorted(filtered_boxes, key=lambda x: x['content'] is None)

    # emira: handle the \"nothing detected\" case (image with no icons + no
    # OCR text — e.g., a map tile or unrecognizable WebGL frame). Without this
    # the pipeline crashes on box_convert with a shape-[0] tensor.
    if not filtered_boxes_elem:
        pil_img = Image.fromarray(image_source)
        buffered = io.BytesIO()
        pil_img.save(buffered, format=\"PNG\")
        encoded_image = base64.b64encode(buffered.getvalue()).decode('ascii')
        return encoded_image, {}, []

    # get the index of the first 'content': None
    starting_idx = next((i for i, box in enumerate(filtered_boxes_elem) if box['content'] is None), -1)""",
)

p.write_text(src)
PY
fi

# Patch 4: util/omniparser.py — upscale EasyOCR's detection input 2× via
# the mag_ratio param. EasyOCR returns coordinates in original-image space
# already, so no downstream coord remap needed. Fixes small-UI-text garble
# like "Sign iIn" / "olrvine" on dense rendered pages (e.g. Google Maps).
OMNI_FILE="$REPO_DIR/util/omniparser.py"
if [[ -f "$OMNI_FILE" ]] && ! grep -q "emira: mag_ratio 2×" "$OMNI_FILE"; then
  python3 - "$OMNI_FILE" <<'PY'
import sys
from pathlib import Path
p = Path(sys.argv[1])
src = p.read_text()
src = src.replace(
    "easyocr_args={'text_threshold': 0.8}",
    "easyocr_args={'text_threshold': 0.8, 'mag_ratio': 2.0}  # emira: mag_ratio 2× detection upscale for small UI text",
)
p.write_text(src)
PY
fi

echo "==> Installing minimal OmniParser inference dependencies"
# We use our own inference-requirements.txt rather than OmniParser's full
# requirements.txt because the upstream list pulls in ~600MB of demo / agent
# deps (gradio, anthropic, paddlepaddle, …) that the detector path doesn't
# need, and is under-constrained enough that pip's resolver thrashes or
# falls back to compiling opencv from source. See the file's header for the
# skip list.
pip install -r omniparser/inference-requirements.txt

echo "==> Downloading model weights"
# OmniParser hosts weights on HuggingFace. The exact download command shifts
# with releases; this is the v2 layout as of writing. If it fails, follow the
# instructions at https://github.com/microsoft/OmniParser#weights and place
# the weights under $REPO_DIR/weights/.
mkdir -p "$REPO_DIR/weights"
# huggingface_hub renamed the CLI from `huggingface-cli` to `hf` in v1.0.
# Prefer the new name; fall back to the old one for older venvs.
if command -v hf >/dev/null 2>&1; then
  hf download microsoft/OmniParser-v2.0 --local-dir "$REPO_DIR/weights"
elif command -v huggingface-cli >/dev/null 2>&1; then
  huggingface-cli download microsoft/OmniParser-v2.0 \
    --local-dir "$REPO_DIR/weights" \
    --local-dir-use-symlinks False
else
  echo "Neither 'hf' nor 'huggingface-cli' found. Install via 'pip install huggingface_hub' and rerun." >&2
  exit 1
fi

cat <<EOF

==> OmniParser setup complete.

To use the OmniParser detector:
  export EMIRA_DETECTOR=omniparser
  export EMIRA_OMNIPARSER_PATH="$PWD/$REPO_DIR"
  npm run build && node dist/http-server.js

Switch back to DOM detector at any time with:
  unset EMIRA_DETECTOR     # or set to 'dom'
EOF

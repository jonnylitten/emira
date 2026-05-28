#!/usr/bin/env python3
"""Python sidecar for marksman's OmniParser detector.

Long-running process. Loads the OmniParser model once at startup, then serves
repeated detection requests over line-delimited JSON on stdin/stdout.

Protocol:
    self  -> {"event":"ready"} on successful model load
    self  -> {"event":"fatal", "error": "..."} if startup fails
    stdin <- {"request_id": "<uuid>", "image_path": "/path/to/png"}
    self  -> {"request_id": "<uuid>", "elements": [
                {"bbox":{"x":..,"y":..,"w":..,"h":..},
                 "type":"button"|"text"|"icon"|...,
                 "text":"..."},
              ...
             ]}

Two modes:
    Default          - imports OmniParser from MARKSMAN_OMNIPARSER_PATH (env)
                       and runs real inference. Fails clearly if not installed.
    MARKSMAN_OMNI_STUB=1 - skips model load; returns a single dummy element per
                       request. Useful for validating the Node↔Python protocol
                       without the ~1GB of weights.
"""
from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

# Homebrew Python on macOS doesn't ship a populated cert bundle; pip works
# because it bundles its own, but stdlib urllib (easyocr's model fetch,
# huggingface_hub, etc.) hits SSL_CERTIFICATE_VERIFY_FAILED. Point the SSL
# stack at certifi's bundle before any module-level HTTPS request fires.
try:
    import certifi
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())
except ImportError:
    pass


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg: str):
    sys.stderr.write(f"{msg}\n")
    sys.stderr.flush()


class StubDetector:
    """Protocol validator. Returns one centered placeholder bbox per request."""

    def detect(self, image_path: str):
        from PIL import Image  # Pillow is light enough that we require it.

        with Image.open(image_path) as im:
            w, h = im.size
        return [
            {
                "bbox": {"x": w // 4, "y": h // 4, "w": w // 2, "h": h // 2},
                "type": "stub",
                "text": "OMNIPARSER_STUB",
            }
        ]


class OmniParserDetector:
    """Real OmniParser detector. Loaded only when MARKSMAN_OMNI_STUB is unset.

    OmniParser isn't a clean pip package — it's a repo (microsoft/OmniParser)
    you clone and import from directly. We add its repo path to sys.path,
    then use its `Omniparser` class.
    """

    def __init__(self):
        repo_path = os.environ.get("MARKSMAN_OMNIPARSER_PATH")
        if not repo_path:
            raise RuntimeError(
                "MARKSMAN_OMNIPARSER_PATH not set. Point it at your cloned "
                "microsoft/OmniParser repository directory."
            )
        repo = Path(repo_path).expanduser().resolve()
        if not repo.is_dir():
            raise RuntimeError(f"OmniParser repo not found at {repo}")

        sys.path.insert(0, str(repo))

        try:
            from util.omniparser import Omniparser  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                f"Could not import OmniParser. Check {repo}/util/. Error: {e}"
            ) from e

        yolo_weights = os.environ.get(
            "MARKSMAN_OMNI_YOLO_WEIGHTS",
            str(repo / "weights/icon_detect/model.pt"),
        )
        caption_weights = os.environ.get(
            "MARKSMAN_OMNI_CAPTION_WEIGHTS",
            str(repo / "weights/icon_caption"),
        )

        for path in (yolo_weights, caption_weights):
            if not Path(path).exists():
                raise RuntimeError(
                    f"Weight path missing: {path}. Run scripts/setup-omniparser.sh "
                    "to download weights, or override the env var to point at them."
                )

        log(f"Loading OmniParser (yolo={yolo_weights}, caption={caption_weights})")
        self.parser = Omniparser(
            {
                "som_model_path": yolo_weights,
                "caption_model_name": "florence2",
                "caption_model_path": caption_weights,
                "BOX_TRESHOLD": 0.05,
            }
        )

    def detect(self, image_path: str):
        import base64
        from PIL import Image

        # Omniparser.parse() takes a base64 string. We also need the original
        # pixel dimensions to convert ratio-coords back to absolute pixels.
        with open(image_path, "rb") as f:
            raw = f.read()
        b64 = base64.b64encode(raw).decode("ascii")
        with Image.open(image_path) as im:
            img_w, img_h = im.size

        _annotated_b64, parsed = self.parser.parse(b64)

        out = []
        for entry in parsed:
            bbox = entry.get("bbox")
            if not bbox or len(bbox) < 4:
                continue
            # Omniparser returns ratio-normalized [x1, y1, x2, y2] coords.
            x1, y1, x2, y2 = bbox
            out.append(
                {
                    "bbox": {
                        "x": int(x1 * img_w),
                        "y": int(y1 * img_h),
                        "w": int((x2 - x1) * img_w),
                        "h": int((y2 - y1) * img_h),
                    },
                    "type": str(entry.get("type", "element")),
                    "text": str(
                        entry.get("content") or entry.get("text") or ""
                    ),
                }
            )
        return out


def main():
    stub = os.environ.get("MARKSMAN_OMNI_STUB") == "1"
    try:
        detector = StubDetector() if stub else OmniParserDetector()
    except Exception as e:
        emit({"event": "fatal", "error": f"{e}"})
        log(traceback.format_exc())
        return 1

    emit({"event": "ready"})

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            emit({"error": f"invalid request json: {e}"})
            continue

        request_id = req.get("request_id")
        image_path = req.get("image_path")
        if not request_id or not image_path:
            emit(
                {
                    "request_id": request_id,
                    "error": "missing request_id or image_path",
                }
            )
            continue

        try:
            elements = detector.detect(image_path)
            emit({"request_id": request_id, "elements": elements})
        except Exception as e:
            log(traceback.format_exc())
            emit({"request_id": request_id, "error": f"{type(e).__name__}: {e}"})

    return 0


if __name__ == "__main__":
    sys.exit(main())

# Detectors

| Name | How | Pros | Cons |
|---|---|---|---|
| `dom` (default) | Walks the live DOM via `page.evaluate`, picks interactive elements (`a`, `button`, `input`, form controls, `[role=*]`, etc.), filters by visibility, merges associated `<label>` text into form-control text. | Fast (~10ms), no setup, accurate for standard web UIs. | Misses canvas / WebGL elements, and any UI rendered without a real DOM element. |
| `omniparser` | Python sidecar runs Microsoft's OmniParser (YOLO icon detector + Florence captioner + OCR) over the screenshot pixels. | Catches canvas-rendered UIs (Figma, Maps, etc.), works on any rendered page. | Heavy: ~1GB weights, GPU recommended, 10-20s per inference on CPU. |

Timing, stated once (other docs reference this): the sidecar currently runs CPU-only, and each inference takes roughly 10 to 20 seconds. The first call in a session is slower still, because it also spawns the Python sidecar and loads about 1GB of model weights. A GPU or Apple's MPS backend would cut inference to a few seconds; that work is tracked in [ROADMAP.md](./ROADMAP.md).

**Select per process:**

```bash
export EMIRA_DETECTOR=omniparser
```

**Or per call (HTTP):**

```bash
curl -X POST localhost:17542/screenshot \
  -H "authorization: Bearer $(cat ~/.emira/http-token)" \
  -H 'content-type: application/json' \
  -d '{"detector":"omniparser","url":"..."}'
```

**Or per call (MCP):** pass `detector: "omniparser"` to `screenshot_mark`.

### OmniParser setup

```bash
bash scripts/setup-omniparser.sh
export EMIRA_DETECTOR=omniparser
export EMIRA_OMNIPARSER_PATH="$PWD/omniparser/OmniParser"
```

The setup script creates a venv at `omniparser/.venv`, clones `microsoft/OmniParser` into `omniparser/OmniParser`, installs its dependencies, and downloads model weights via `huggingface-cli`. The Python sidecar (`omniparser/infer.py`) is spawned lazily on first detection and kept alive for the emira process lifetime.

The sidecar protocol is line-delimited JSON over stdin/stdout:

```
sidecar → node: {"event":"ready"}
node → sidecar: {"request_id":"<uuid>","image_path":"/tmp/.../shot.png"}
sidecar → node: {"request_id":"<uuid>","elements":[{"bbox":{"x":..,"y":..,"w":..,"h":..},"type":"...","text":"..."}]}
```

For a protocol-only smoke test without downloading model weights:

```bash
bash scripts/setup-omniparser.sh --stub
EMIRA_OMNI_STUB=1 EMIRA_DETECTOR=omniparser node dist/http-server.js
```

The stub returns one centered placeholder bbox per request, enough to exercise the Node↔Python plumbing.

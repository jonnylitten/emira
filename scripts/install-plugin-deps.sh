#!/usr/bin/env bash
# SessionStart hook for the marksman plugin.
#
# Installs marksman's Node dependencies into $CLAUDE_PLUGIN_DATA on first
# session and re-runs `npm install` only when the bundled package.json has
# changed (covers plugin updates that bump deps). Also ensures Playwright's
# Chromium binary is present.
#
# Why $CLAUDE_PLUGIN_DATA and not the plugin root: marketplace-installed
# plugins are copied into a cache directory that's re-created on every update.
# Per the plugin docs, the data directory persists across versions — the
# right home for node_modules. The MCP server config sets NODE_PATH to point
# Node at this location.

set -e

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-}"
DATA="${CLAUDE_PLUGIN_DATA:-}"

if [[ -z "$PLUGIN_ROOT" || -z "$DATA" ]]; then
  echo "marksman: CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA not set; running outside a plugin context — skipping install" >&2
  exit 0
fi

mkdir -p "$DATA"

# Fast path: stored package.json matches the bundled one, nothing to do.
if diff -q "$PLUGIN_ROOT/package.json" "$DATA/package.json" >/dev/null 2>&1; then
  exit 0
fi

echo "marksman: installing Node deps into $DATA (one-time per plugin version)"

cp "$PLUGIN_ROOT/package.json" "$DATA/package.json"
if [[ -f "$PLUGIN_ROOT/package-lock.json" ]]; then
  cp "$PLUGIN_ROOT/package-lock.json" "$DATA/package-lock.json"
fi

# npm install with --omit=dev — runtime deps only (no vitest, typescript, etc.)
if ! ( cd "$DATA" && npm install --no-fund --no-audit --omit=dev ); then
  echo "marksman: npm install failed — clearing stored package.json so next session retries" >&2
  rm -f "$DATA/package.json"
  exit 1
fi

# Playwright's Chromium binary lives in the OS cache (~/Library/Caches/ms-playwright
# on macOS), so it's installed once per machine rather than per plugin version.
# Skip if PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set (CI / pre-provisioned).
if [[ -z "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-}" ]]; then
  if [[ -x "$DATA/node_modules/.bin/playwright" ]]; then
    if ! ( cd "$DATA" && ./node_modules/.bin/playwright install chromium ); then
      echo "marksman: Playwright Chromium install failed — clearing stored package.json so next session retries" >&2
      rm -f "$DATA/package.json"
      exit 1
    fi
  fi
fi

echo "marksman: ready"

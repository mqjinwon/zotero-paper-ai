#!/usr/bin/env bash
# Build and copy XPI into a local Zotero profile (dev loop).
# Override: ZOTERO_PROFILE_DIR=/path/to/profile npm run deploy:local
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm run build

XPI="$ROOT/.scaffold/build/paper-ai-colleague.xpi"
if [[ ! -f "$XPI" ]]; then
  # fallback: any xpi in build dir
  XPI="$(ls -1 "$ROOT"/.scaffold/build/*.xpi 2>/dev/null | head -1 || true)"
fi
if [[ -z "${XPI:-}" || ! -f "$XPI" ]]; then
  echo "missing XPI under .scaffold/build/" >&2
  exit 1
fi

# Addon id must match package.json config.addonID (manifest)
ADDON_ID="$(node -p "require('./package.json').config.addonID" 2>/dev/null || echo 'paper-ai@mqjinwon.github.io')"

resolve_profile_dir() {
  if [[ -n "${ZOTERO_PROFILE_DIR:-}" ]]; then
    echo "$ZOTERO_PROFILE_DIR"
    return
  fi
  local base="${HOME}/.zotero/zotero"
  local ini="${base}/profiles.ini"
  if [[ -f "$ini" ]]; then
    # Prefer Path= under [Profile*] with Default=1, else first Path=
    local def path
    def="$(awk -F= '
      /^\[Profile/ { p=1; d=0; path="" }
      p && $1=="Default" && $2=="1" { d=1 }
      p && $1=="Path" { path=$2 }
      p && d && path!="" { print path; exit }
    ' "$ini")"
    if [[ -z "$def" ]]; then
      def="$(awk -F= '/^Path=/{print $2; exit}' "$ini")"
    fi
    if [[ -n "$def" ]]; then
      if [[ "$def" = /* ]]; then
        echo "$def"
      else
        echo "${base}/${def}"
      fi
      return
    fi
  fi
  # last resort: any *.default under ~/.zotero/zotero
  local any
  any="$(ls -d "${base}"/*.default 2>/dev/null | head -1 || true)"
  if [[ -n "$any" ]]; then
    echo "$any"
    return
  fi
  echo ""
}

PROFILE_DIR="$(resolve_profile_dir)"
if [[ -z "$PROFILE_DIR" || ! -d "$PROFILE_DIR" ]]; then
  echo "Could not find Zotero profile. Set ZOTERO_PROFILE_DIR=/path/to/profile" >&2
  exit 1
fi

EXT_DIR="${PROFILE_DIR}/extensions"
mkdir -p "$EXT_DIR"
DEST="${EXT_DIR}/${ADDON_ID}.xpi"
cp -f "$XPI" "$DEST"
echo "Deployed: $DEST ($(wc -c < "$DEST") bytes)"
echo "Profile:  $PROFILE_DIR"
echo "Addon ID: $ADDON_ID"
echo "Restart Zotero (or Tools → Add-ons → reload) to load the new build."

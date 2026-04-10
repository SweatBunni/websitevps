#!/usr/bin/env bash
# CodexMC VPS: install Eclipse Temurin JDKs into /opt/codexmc/jdks/{17,21,25}
# Debian/Ubuntu: sudo bash scripts/setup-jdks.sh

set -euo pipefail

ROOT="/opt/codexmc/jdks"
mkdir -p "$ROOT"

download_and_unpack() {
  local version="$1"
  local release_type="${2:-ga}"
  local dest="$ROOT/$version"
  if [[ -x "$dest/bin/java" ]]; then
    echo "JDK $version already present at $dest"
    return 0
  fi
  local url="https://api.adoptium.net/v3/binary/latest/${version}/${release_type}/linux/x64/jdk/hotspot/normal/eclipse"
  echo "Fetching Temurin $version ($release_type)..."
  local tmp
  tmp="$(mktemp)"
  if ! curl -fL --retry 3 -o "$tmp" "$url"; then
    rm -f "$tmp"
    echo "Warning: could not download JDK $version ($release_type)."
    return 1
  fi
  mkdir -p "$dest"
  tar -xzf "$tmp" -C "$dest" --strip-components=1
  rm -f "$tmp"
  echo "Installed JDK $version -> $dest"
}

download_and_unpack 17 ga || true
download_and_unpack 21 ga || true
download_and_unpack 25 ga || download_and_unpack 25 ea || true

PROFILE_D="/etc/profile.d/codexmc-jdks.sh"
cat >"$PROFILE_D" <<'EOF'
export JDK_17_HOME=/opt/codexmc/jdks/17
export JDK_21_HOME=/opt/codexmc/jdks/21
export JDK_25_HOME=/opt/codexmc/jdks/25
export JAVA_HOME="${JDK_21_HOME}"
export PATH="$JAVA_HOME/bin:$PATH"
EOF
chmod 644 "$PROFILE_D"

echo "Done. Open a new shell or: source $PROFILE_D"

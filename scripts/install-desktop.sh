#!/usr/bin/env bash
set -euo pipefail

# Download only versioned assets from the OpenBot release repository. Never execute a response
# as shell code, disable OS trust checks, elevate privileges, or replace an existing installation.
version="${1:-0.1.0-alpha.8}"
if [[ "$version" == "--help" ]]; then
  echo 'Usage: bash install-desktop.sh [version]'
  echo 'Installs macOS arm64 to ~/Applications or Linux x64 to ~/.local/opt/openbot/<version>.'
  echo 'Requires a published desktop-v<version> GitHub Release. Existing installations are retained.'
  exit 0
fi
if [[ "$#" -gt 1 || ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-(alpha|beta|rc)\.[0-9]+)?$ ]]; then
  echo 'Invalid Desktop version.' >&2
  exit 1
fi
if [[ "$(id -u)" == "0" ]]; then
  echo 'Run this installer as your normal desktop user, without sudo.' >&2
  exit 1
fi
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=darwin; arch=arm64; extension=dmg ;;
  Linux-x86_64) platform=linux; arch=x64; extension=AppImage ;;
  *) echo 'Unsupported target. Use the Windows PowerShell installer or the documented downloads.' >&2; exit 1 ;;
esac
command -v curl >/dev/null
# Older curl only enforces max-filesize when Content-Length is known before transfer.
curl_version="$(curl --version | awk 'NR == 1 { print $2 }')"
if [[ ! "$curl_version" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] ||
   (( 10#${BASH_REMATCH[1]} < 8 || (10#${BASH_REMATCH[1]} == 8 && 10#${BASH_REMATCH[2]} < 4) )); then
  echo 'Command installation requires curl 8.4.0 or newer for bounded downloads. Use the documented native installer download instead.' >&2
  exit 1
fi
if command -v shasum >/dev/null; then
  hash_command=(shasum -a 256)
elif command -v sha256sum >/dev/null; then
  hash_command=(sha256sum)
else
  echo 'A SHA-256 utility is required.' >&2
  exit 1
fi
asset="openbot-desktop-$version-$platform-$arch.$extension"
base="https://github.com/yxflc11/openbot/releases/download/desktop-v$version"
stage="$(mktemp -d "${TMPDIR:-/tmp}/openbot-install.XXXXXXXX")"
mounted=false
install_lock=""
install_stage=""
cleanup() {
  if [[ -n "$install_stage" ]]; then rm -rf -- "$install_stage"; fi
  if [[ -n "$install_lock" ]]; then rmdir "$install_lock" || true; fi
  if [[ "$mounted" == true ]] && ! /usr/bin/hdiutil detach "$stage/mount" -quiet; then
    echo "Retained mounted installer at $stage for manual cleanup." >&2
    return
  fi
  rm -rf -- "$stage"
}
trap cleanup EXIT
echo "Downloading OpenBot Desktop $version ($platform $arch)…"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --silent --show-error --max-time 60 --max-filesize 16384 \
  "$base/SHA256SUMS" --output "$stage/SHA256SUMS"
expected="$(awk -v name="$asset" '$2 == name { print $1 }' "$stage/SHA256SUMS")"
if [[ ! "$expected" =~ ^[a-f0-9]{64}$ ]]; then
  echo 'The release does not contain exactly one checksum for this installer.' >&2
  exit 1
fi
curl --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --silent --show-error --max-time 900 --max-filesize 2147483648 \
  "$base/$asset" --output "$stage/$asset"
actual="$("${hash_command[@]}" "$stage/$asset" | awk '{ print $1 }')"
if [[ "$actual" != "$expected" ]]; then
  echo 'Installer checksum mismatch; nothing was installed.' >&2
  exit 1
fi
if [[ "$platform" == darwin ]]; then
  destination="$HOME/Applications/OpenBot.app"
  if [[ -L "$HOME/Applications" || -e "$destination" || -L "$destination" ]]; then
    echo 'An installation or linked Applications directory already exists. Use the DMG to review an upgrade.' >&2
    exit 1
  fi
  mkdir -p "$HOME/Applications" "$stage/mount"
  mkdir "$HOME/Applications/.openbot-install.lock"
  install_lock="$HOME/Applications/.openbot-install.lock"
  if [[ -e "$destination" || -L "$destination" ]]; then
    echo 'Another installation appeared; it was retained.' >&2
    exit 1
  fi
  /usr/bin/hdiutil attach "$stage/$asset" -readonly -nobrowse -mountpoint "$stage/mount" -quiet
  mounted=true
  if [[ ! -d "$stage/mount/OpenBot.app" || -L "$stage/mount/OpenBot.app" ]]; then
    echo 'The disk image does not contain the expected application.' >&2
    exit 1
  fi
  /usr/bin/ditto "$stage/mount/OpenBot.app" "$stage/OpenBot.app"
  # Preserve the downloaded-app trust boundary even when curl did not attach quarantine metadata.
  /usr/bin/xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");OpenBot;" "$stage/OpenBot.app"
  mv -n "$stage/OpenBot.app" "$destination"
  echo "Installed: $destination"
  echo 'Open it from Finder. macOS signing and Gatekeeper requirements still apply.'
else
  destination="$HOME/.local/opt/openbot/$version"
  for parent in "$HOME/.local" "$HOME/.local/opt" "$HOME/.local/opt/openbot" "$destination"; do
    if [[ -L "$parent" ]]; then echo 'Refusing a linked installation directory.' >&2; exit 1; fi
  done
  if [[ -e "$destination" ]]; then
    if [[ -f "$destination/openbot.AppImage" && ! -L "$destination/openbot.AppImage" ]] &&
       [[ "$("${hash_command[@]}" "$destination/openbot.AppImage" | awk '{ print $1 }')" == "$expected" ]]; then
      echo 'This verified version is already installed; it was retained.'
      exit 0
    fi
    echo 'An incomplete or different installation already exists. Review that directory before retrying.' >&2
    exit 1
  fi
  mkdir -p "$HOME/.local/opt/openbot"
  install_stage="$(mktemp -d "$HOME/.local/opt/openbot/.install-$version.XXXXXXXX")"
  install -m 0755 "$stage/$asset" "$install_stage/openbot.AppImage"
  # GNU/BusyBox no-target-directory semantics prevent nesting into a concurrent installation.
  if ! mv -nT -- "$install_stage" "$destination"; then
    if [[ -e "$destination" || -L "$destination" ]]; then
      echo 'Another installation appeared; it was retained.' >&2
    else
      echo 'Unable to publish the installation; its private staging directory will be removed.' >&2
    fi
    exit 1
  fi
  if [[ -d "$install_stage" ]]; then
    echo 'Another installation appeared; it was retained.' >&2
    exit 1
  fi
  install_stage=""
  echo "Installed: $destination/openbot.AppImage"
  echo 'Run that file to open Desktop. If AppImage runtime dependencies are unavailable, use the DEB download.'
fi
echo 'Installation does not configure a model, enable inference, or enroll a Worker.'

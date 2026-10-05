#!/usr/bin/env bash
# Builds the Flatpak repo served at https://that-one-tool.github.io/dasshboard/flatpak/
# from a release .deb.
#
#   build-repo.sh <dasshboard.deb> <out-dir> [gpg-key-id]
#
# <out-dir> receives repo/ (the OSTree repo), dasshboard.flatpakrepo and
# dasshboard.flatpakref. With a GPG key id (already in the gpg keyring) the
# repo is signed and both files carry the public key; without one the repo is
# unsigned, for local testing only (add it with --no-gpg-verify).
#
# Needs flatpak-builder, or the org.flatpak.Builder Flatpak. The work dir is in
# ~/.cache: not /tmp, which the Builder Flatpak can't see, and not the repo,
# since a build dir holds symlinks to /run that tools like Vitest would follow.
set -euo pipefail

APP_ID=io.github.that_one_tool.DaSSHboard
BRANCH=stable
BASE_URL=https://that-one-tool.github.io/dasshboard/flatpak
# Flathub's shared module definitions (libayatana-appindicator), pinned.
SHARED_MODULES_URL=https://github.com/flathub/shared-modules.git
SHARED_MODULES_COMMIT=cb9ec602a1ece1c76d5a4f8aa1d87c4a6bf99c3e

here=$(cd "$(dirname "$0")" && pwd)
deb=$(realpath "$1")
out=$(realpath -m "$2")
key_id=${3:-}
work="${XDG_CACHE_HOME:-$HOME/.cache}/dasshboard-flatpak"
stage="$work/stage"

# Build dependencies go to the user installation for a host flatpak-builder (its
# default is the system one, where CI has no Flathub remote). Not for the
# Builder Flatpak: its --user means a folder inside its own sandbox.
builder() {
	if command -v flatpak-builder >/dev/null; then
		flatpak-builder --user "$@"
	else
		flatpak run --command=flatpak-builder org.flatpak.Builder "$@"
	fi
}

stage_sources() {
	rm -rf "$stage"
	mkdir -p "$stage"
	cp "$here/$APP_ID.yml" "$here/$APP_ID.desktop" "$stage/"
	cp "$deb" "$stage/dasshboard.deb"
	local version
	version=$(sed -nE 's/^\s*"version": "([^"]+)".*/\1/p' "$here/../src-tauri/tauri.conf.json" | head -1)
	sed -e "s/@VERSION@/$version/" -e "s/@DATE@/$(date -u +%F)/" \
		"$here/$APP_ID.metainfo.xml" >"$stage/$APP_ID.metainfo.xml"
	git clone --quiet "$SHARED_MODULES_URL" "$stage/shared-modules"
	git -C "$stage/shared-modules" checkout --quiet "$SHARED_MODULES_COMMIT"
}

sign_args() {
	if [ -n "$key_id" ]; then echo "--gpg-sign=$key_id"; fi
}

build_repo() {
	rm -rf "$out/repo"
	mkdir -p "$out"
	builder --force-clean --disable-rofiles-fuse \
		--install-deps-from=flathub --state-dir="$work/state" \
		--default-branch="$BRANCH" --repo="$out/repo" $(sign_args) \
		"$work/app" "$stage/$APP_ID.yml"
	flatpak build-update-repo --generate-static-deltas --prune \
		--title=DaSSHboard $(sign_args) "$out/repo"
}

gpg_key_line() {
	if [ -n "$key_id" ]; then echo "GPGKey=$(gpg --export "$key_id" | base64 -w0)"; fi
}

write_remote_files() {
	cat >"$out/dasshboard.flatpakrepo" <<EOF
[Flatpak Repo]
Title=DaSSHboard
Url=$BASE_URL/repo/
Homepage=https://that-one-tool.github.io/dasshboard/
Comment=DaSSHboard, the SSH devices dashboard
$(gpg_key_line)
EOF
	cat >"$out/dasshboard.flatpakref" <<EOF
[Flatpak Ref]
Name=$APP_ID
Branch=$BRANCH
Title=DaSSHboard
Url=$BASE_URL/repo/
SuggestRemoteName=dasshboard
RuntimeRepo=https://dl.flathub.org/repo/flathub.flatpakrepo
IsRuntime=false
$(gpg_key_line)
EOF
}

stage_sources
build_repo
write_remote_files
echo "Flatpak repo ready in $out"

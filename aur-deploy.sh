#!/bin/bash
# AUR Package Deployment Script for Social Stream Ninja
set -euo pipefail

AUR_REPO_DIR="aur-repo"
SSH_KEY_PATH="certs/id_ed25519_aur"
PKGBUILD_PATH="aur/PKGBUILD"

if [ $# -ne 1 ] || [[ ! "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$ ]]; then
    echo "Usage: ./aur-deploy.sh <version> (for example, 0.4.48)" >&2
    exit 1
fi
VERSION=$1

if [ ! -f package.json ] || [ ! -f "$PKGBUILD_PATH" ]; then
    echo "Run this script from the ssapp repository root." >&2
    exit 1
fi
if [ ! -f "$SSH_KEY_PATH" ]; then
    echo "AUR SSH key not found at $SSH_KEY_PATH" >&2
    exit 1
fi
for tool in curl sha256sum git; do
    command -v "$tool" >/dev/null || { echo "Required command not found: $tool" >&2; exit 1; }
done

# Keep the user's SSH configuration and keys untouched. Pin newly seen hosts,
# and reject a changed host key on later connections.
printf -v GIT_SSH_COMMAND 'ssh -i %q -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new' "$PWD/$SSH_KEY_PATH"
export GIT_SSH_COMMAND

# Hash the actual release and the desktop file before publishing package metadata.
APPIMAGE=$(mktemp)
trap 'rm -f -- "$APPIMAGE"' EXIT
curl --fail --location --proto '=https' --proto-redir '=https' \
    "https://github.com/steveseguin/social_stream/releases/download/v${VERSION}/socialstreamninja_linux_v${VERSION}_x86_64.AppImage" \
    --output "$APPIMAGE"
if [ "$(head -c 4 "$APPIMAGE" | od -An -tx1 | tr -d ' \n')" != "7f454c46" ]; then
    echo "The release download is not an ELF AppImage." >&2
    exit 1
fi
CHECKSUM=$(sha256sum "$APPIMAGE" | cut -d ' ' -f 1)
# Match the line endings installed by makepkg and used by the automated workflow.
sed -i 's/\r$//' "$PKGBUILD_PATH" aur/socialstreamninja.desktop
DESKTOP_CHECKSUM=$(sha256sum aur/socialstreamninja.desktop | cut -d ' ' -f 1)

sed -i "s/^pkgver=.*/pkgver=$VERSION/" "$PKGBUILD_PATH"
sed -i "s/^_release_tag=.*/_release_tag=v$VERSION/" "$PKGBUILD_PATH"
sed -i "/^sha256sums=/,+1c\\sha256sums=('$CHECKSUM'\\n            '$DESKTOP_CHECKSUM')" "$PKGBUILD_PATH"

if [ -d "$AUR_REPO_DIR" ]; then
    git -C "$AUR_REPO_DIR" pull --ff-only
else
    git clone ssh://aur@aur.archlinux.org/socialstreamninja.git "$AUR_REPO_DIR"
fi
cp "$PKGBUILD_PATH" aur/socialstreamninja.desktop "$AUR_REPO_DIR/"
cp "$APPIMAGE" "$AUR_REPO_DIR/socialstreamninja-$VERSION.AppImage"
cd "$AUR_REPO_DIR"

# Verify both source files, including the makepkg-free path.
printf '%s  %s\n' "$CHECKSUM" "socialstreamninja-$VERSION.AppImage" \
    "$DESKTOP_CHECKSUM" socialstreamninja.desktop | sha256sum --check --status
if command -v makepkg >/dev/null; then
    makepkg --verifysource --noconfirm
    makepkg --printsrcinfo > .SRCINFO
else
    # Read the checked-in package definition so fallback metadata stays in sync.
    (
        source ./PKGBUILD
        printf 'pkgbase = %s\n' "$pkgname"
        printf '\tpkgdesc = %s\n\tpkgver = %s\n\tpkgrel = %s\n\turl = %s\n' "$pkgdesc" "$pkgver" "$pkgrel" "$url"
        printf '\tarch = %s\n' "${arch[@]}"
        printf '\tlicense = %s\n' "${license[@]}"
        printf '\tdepends = %s\n' "${depends[@]}"
        printf '\toptdepends = %s\n' "${optdepends[@]}"
        printf '\tprovides = %s\n' "${provides[@]}"
        printf '\tconflicts = %s\n' "${conflicts[@]}"
        printf '\tnoextract = %s\n' "${noextract[@]}"
        printf '\toptions = %s\n' "${options[@]}"
        printf '\tsource = %s\n' "${source[@]}"
        printf '\tsha256sums = %s\n' "${sha256sums[@]}"
        printf '\npkgname = %s\n' "$pkgname"
    ) > .SRCINFO
fi
if grep -Eq 'sha256sums[[:space:]]*=[[:space:]]*SKIP' .SRCINFO ||
    ! grep -Eq "^[[:space:]]+sha256sums = $CHECKSUM$" .SRCINFO ||
    ! grep -Eq "^[[:space:]]+sha256sums = $DESKTOP_CHECKSUM$" .SRCINFO; then
    echo "Refusing to publish metadata without matching source checksums." >&2
    exit 1
fi

# Stage package metadata only, never the downloaded release or unrelated files.
git add PKGBUILD .SRCINFO socialstreamninja.desktop
if git diff --cached --quiet; then
    echo "AUR package metadata is already up to date."
    exit 0
fi
git commit -m "Update to version $VERSION"
git push origin master
echo "Published socialstreamninja $VERSION to AUR."

#!/bin/bash
# AUR Package Deployment Script for Social Stream Ninja
# This script updates and deploys the AUR package

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
AUR_REPO_DIR="aur-repo"
SSH_KEY_PATH="certs/id_ed25519_aur"
PKGBUILD_PATH="aur/PKGBUILD"

echo -e "${GREEN}AUR Package Deployment Script${NC}"
echo "==============================="

# Check if version is provided
if [ $# -eq 0 ]; then
    echo -e "${RED}Error: Please provide version number${NC}"
    echo "Usage: ./aur-deploy.sh <version>"
    echo "Example: ./aur-deploy.sh 0.3.44"
    exit 1
fi

VERSION=$1

# Verify we're in the right directory
if [ ! -f "package.json" ]; then
    echo -e "${RED}Error: Must run from ssapp root directory${NC}"
    exit 1
fi

# Check if SSH key exists
if [ ! -f "$SSH_KEY_PATH" ]; then
    echo -e "${RED}Error: SSH key not found at $SSH_KEY_PATH${NC}"
    echo "Make sure your AUR SSH key is in the certs folder"
    exit 1
fi

# Set up SSH for this session
echo -e "${YELLOW}Setting up SSH...${NC}"
mkdir -p ~/.ssh
cp "$SSH_KEY_PATH" ~/.ssh/id_ed25519_aur
cp "${SSH_KEY_PATH}.pub" ~/.ssh/id_ed25519_aur.pub
chmod 600 ~/.ssh/id_ed25519_aur
chmod 644 ~/.ssh/id_ed25519_aur.pub

# Configure SSH for AUR
cat > ~/.ssh/config << EOF
Host aur.archlinux.org
    User aur
    IdentityFile ~/.ssh/id_ed25519_aur
    StrictHostKeyChecking no
EOF

# Clone or update AUR repo
if [ -d "$AUR_REPO_DIR" ]; then
    echo -e "${YELLOW}Updating existing AUR repository...${NC}"
    cd "$AUR_REPO_DIR"
    git pull
    cd ..
else
    echo -e "${YELLOW}Cloning AUR repository...${NC}"
    git clone ssh://aur@aur.archlinux.org/socialstreamninja.git "$AUR_REPO_DIR"
fi

# Update version in PKGBUILD
echo -e "${YELLOW}Updating PKGBUILD version to $VERSION...${NC}"
sed -i "s/pkgver=.*/pkgver=$VERSION/" "$PKGBUILD_PATH"

# Copy updated files
echo -e "${YELLOW}Copying package files...${NC}"
cp aur/PKGBUILD "$AUR_REPO_DIR/"
cp aur/socialstreamninja.desktop "$AUR_REPO_DIR/"

# Generate .SRCINFO
echo -e "${YELLOW}Generating .SRCINFO...${NC}"
cd "$AUR_REPO_DIR"
makepkg --printsrcinfo > .SRCINFO 2>/dev/null || {
    echo -e "${YELLOW}Warning: makepkg not available, generating basic .SRCINFO${NC}"
    cat > .SRCINFO << EOF
pkgbase = socialstreamninja
	pkgdesc = Standalone version of Social Stream Ninja - Electron-based application for capturing social media streams
	pkgver = $VERSION
	pkgrel = 1
	url = https://github.com/steveseguin/ssn_app
	arch = x86_64
	license = GPL3
	depends = fuse2
	depends = gtk3
	depends = nss
	depends = libxss
	depends = libnotify
	depends = libxtst
	depends = xdg-utils
	noextract = socialstreamninja-$VERSION.AppImage
	options = !strip
	source = socialstreamninja-$VERSION.AppImage::https://github.com/steveseguin/ssn_app/releases/download/v$VERSION/socialstreamninja_linux_v${VERSION}_x86_64.AppImage
	source = socialstreamninja.desktop
	sha256sums = SKIP
	sha256sums = SKIP

pkgname = socialstreamninja
EOF
}

# Commit and push
echo -e "${YELLOW}Committing changes...${NC}"
git add .
git commit -m "Update to version $VERSION" || {
    echo -e "${YELLOW}No changes to commit${NC}"
    exit 0
}

echo -e "${YELLOW}Pushing to AUR...${NC}"
git push origin master

echo -e "${GREEN}✓ Successfully deployed version $VERSION to AUR!${NC}"
echo -e "${GREEN}Package URL: https://aur.archlinux.org/packages/socialstreamninja${NC}"

# Clean up SSH keys from temp location
rm -f ~/.ssh/id_ed25519_aur ~/.ssh/id_ed25519_aur.pub

echo -e "${YELLOW}Remember to:${NC}"
echo "1. Create a GitHub release with tag v$VERSION"
echo "2. Upload the AppImage to the release"
echo "3. Update package.json version if not already done"
# AUR Deployment Guide

This guide explains how to update the Social Stream Ninja AUR package when releasing new versions.

## Prerequisites

1. AUR account with SSH key configured
2. SSH private key stored in `certs/id_ed25519_aur`
3. `makepkg` installed (or the script will generate a basic .SRCINFO)

## Quick Deploy

Use the automated script:

```bash
./aur-deploy.sh 0.3.44
```

Replace `0.3.44` with your new version number.

## Manual Process

If you prefer to do it manually:

1. **Update version in PKGBUILD**:
   ```bash
   sed -i "s/pkgver=.*/pkgver=0.3.44/" aur/PKGBUILD
   ```

2. **Clone/update AUR repo**:
   ```bash
   git clone ssh://aur@aur.archlinux.org/socialstreamninja.git aur-repo
   cd aur-repo
   ```

3. **Copy files**:
   ```bash
   cp ../aur/PKGBUILD .
   cp ../aur/socialstreamninja.desktop .
   ```

4. **Generate .SRCINFO**:
   ```bash
   makepkg --printsrcinfo > .SRCINFO
   ```

5. **Commit and push**:
   ```bash
   git add .
   git commit -m "Update to version 0.3.44"
   git push
   ```

## Release Checklist

When releasing a new version:

- [ ] Update version in `package.json`
- [ ] Build all platforms (Windows, Linux, macOS)
- [ ] Create GitHub release with tag `v0.3.44`
- [ ] Upload all build artifacts to release
- [ ] Run `./aur-deploy.sh 0.3.44`
- [ ] Verify package on https://aur.archlinux.org/packages/socialstreamninja

## Troubleshooting

### SSH Key Issues
- Ensure your AUR SSH key is in `certs/id_ed25519_aur`
- Check that the key has correct permissions (600)

### makepkg Not Found
- The script will generate a basic .SRCINFO if makepkg isn't available
- For full functionality, install base-devel: `sudo pacman -S base-devel`

### Push Rejected
- Make sure you're the package maintainer
- Check that your SSH key matches the one in your AUR account

## Security Notes

- Never commit the SSH private key
- The `certs/` folder is gitignored
- Only the desktop file and PKGBUILD are public
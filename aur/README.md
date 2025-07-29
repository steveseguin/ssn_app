# Social Stream Ninja AUR Package

This directory contains the files needed to create an AUR (Arch User Repository) package for Social Stream Ninja.

## Installation

### From AUR (when published)
```bash
yay -S socialstreamninja
# or
paru -S socialstreamninja
```

### Manual Installation (for testing)
```bash
cd aur/
makepkg -si
```

## What this package does

1. Downloads the official AppImage from GitHub releases
2. Installs it to `/opt/socialstreamninja/`
3. Creates a symlink in `/usr/bin/` for command-line access
4. Extracts and installs the application icon
5. Installs a desktop entry for application launchers

## Updating the package

When a new version is released:

1. Update `pkgver` in PKGBUILD
2. Regenerate .SRCINFO: `makepkg --printsrcinfo > .SRCINFO`
3. Update SHA256 checksums: `updpkgsums`
4. Test the build: `makepkg -si`
5. Submit to AUR

## Dependencies

The package depends on:
- `fuse2` - Required for AppImage execution
- GTK3 and related libraries for Electron
- Standard desktop integration tools

## Notes

- This package uses the pre-built AppImage to avoid compilation
- The AppImage includes its own Electron runtime
- Updates will be available through AUR helpers when new releases are published
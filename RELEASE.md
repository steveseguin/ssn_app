# Release Guide

## Critical Rules

- Do not create git tags in this repository (`ssapp` / `ssn_app`).
- Do not publish GitHub releases in `steveseguin/ssn_app`.
- This repository builds the desktop wrapper binary, but the Social Stream project home is `steveseguin/social_stream`.
- App release tags and release artifacts belong in `steveseguin/social_stream`.
- Create new GitHub releases as **pre-releases**. Steve will promote them to full releases when ready.
- If Steve says to "ship a release", confirm the target and scope before creating tags, releases, or uploading artifacts.

## Repository Roles

- `C:\Users\steve\Code\ssapp` / `steveseguin/ssn_app`: desktop Electron wrapper source and build repo.
- `C:\Users\steve\Code\social_stream` / `steveseguin/social_stream`: main Social Stream project, public release home, and release-download target.

## Manual Numbered Pre-Release Runbook

Use this checklist for a numbered Windows/Linux pre-release. Replace `0.4.12` with the requested version.

### 1. Confirm the release

- Confirm the version and the `steveseguin/social_stream` target with Steve.
- Read this entire file before changing versions, building, tagging, or publishing.
- Check that the version does not already have a release or tag:

```powershell
gh release view v0.4.12 -R steveseguin/social_stream
git ls-remote --tags https://github.com/steveseguin/social_stream.git refs/tags/v0.4.12
```

- Review recent `steveseguin/social_stream` release names, notes, and assets:

```powershell
gh release list -R steveseguin/social_stream --limit 10
gh release view v<previous-version> -R steveseguin/social_stream
```

### 2. Prepare both repositories

- The Social Stream changes being released must be committed and pushed to `social_stream/beta`.
- Follow `social_stream/AGENTS.md` exactly when pushing that repository.
- Bump the version in `ssapp/package.json`. Update the lockfile too if it is tracked.
- Commit and push the SSApp version bump directly to `ssapp/main`.
- Never create the application release tag in `ssapp`.
- Confirm both repositories have no uncommitted files before building.

### 3. Run relevant tests

- Run the tests related to the changed code before packaging.
- For TikTok replay/flood changes, run at least:

```powershell
node tests/tiktok/dedupe-replay-regression.js
node tests/tiktok/event-capture-regression.js
npm run test:tiktok-dom-replay
```

- A title saying the build is untested does not replace basic build and regression checks. It means the package has not completed broad real-world user testing.

### 4. Create a safe artifact folder

Both platform prebuilds clean `dist/`. Copy the Windows files elsewhere before starting Linux.

```powershell
$version = "0.4.12"
$releaseRoot = Join-Path $env:TEMP ("ssapp-v{0}-release-{1}" -f $version, [DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
$windowsArtifacts = Join-Path $releaseRoot "windows"
$linuxArtifacts = Join-Path $releaseRoot "linux"
New-Item -ItemType Directory -Path $windowsArtifacts, $linuxArtifacts | Out-Null
```

### 5. Build Windows from Social Stream beta

For a numbered beta-backed pre-release, these environment variables are required. Plain `npm run build:win32` defaults to `social_stream/main` and can omit unreleased fixes.

```powershell
cd C:\Users\steve\Code\ssapp
$env:SSN_SOCIALSTREAM_BRANCH = "beta"
$env:SSN_SOCIALSTREAM_OUTPUT_BRANCH = "main"
npm run build:win32
```

The build output must say that it cloned `social_stream.git#beta` and updated the bundled `main` source.

Expected files:

```txt
dist/socialstreamninja-setup-0.4.12.exe
dist/socialstreamninja-portable.exe
dist/socialstreamninja_win_v0.4.12_installer.zip
dist/socialstreamninja_win_v0.4.12_portable.zip
```

Submit the two executables to VirusTotal:

```powershell
npm run submit:virustotal
```

Copy all four Windows files before Linux cleans `dist/`:

```powershell
Copy-Item -LiteralPath "dist/socialstreamninja-setup-$version.exe" -Destination $windowsArtifacts
Copy-Item -LiteralPath "dist/socialstreamninja-portable.exe" -Destination $windowsArtifacts
Copy-Item -LiteralPath "dist/socialstreamninja_win_v${version}_installer.zip" -Destination $windowsArtifacts
Copy-Item -LiteralPath "dist/socialstreamninja_win_v${version}_portable.zip" -Destination $windowsArtifacts
```

### 6. Build Linux from the same Social Stream beta

Build under WSL2 after saving the Windows files:

```powershell
wsl.exe -d Ubuntu -- bash -lc 'cd /mnt/c/Users/steve/Code/ssapp && export SSN_SOCIALSTREAM_BRANCH=beta && export SSN_SOCIALSTREAM_OUTPUT_BRANCH=main && npm run build:linux'
```

The output must again say it cloned `social_stream.git#beta` and updated the bundled `main` source.

Copy the AppImage:

```powershell
Copy-Item -LiteralPath "dist/socialstreamninja_linux_v${version}_x86_64.AppImage" -Destination $linuxArtifacts
```

### 7. Validate the packages

- Confirm there are exactly four Windows files and one Linux file.
- Confirm the Windows executables report the requested version and contain the expected signer.
- A local self-signed certificate may report an untrusted or unknown trust status; the presence and identity of the signature are the important local checks.
- Test both ZIP indexes and record SHA-256 hashes:

```powershell
Get-ChildItem -LiteralPath $windowsArtifacts -Filter "*.exe" | ForEach-Object {
    $_.VersionInfo | Select-Object FileName, ProductVersion
    Get-AuthenticodeSignature -LiteralPath $_.FullName | Select-Object Status, SignerCertificate
}

Get-ChildItem -LiteralPath $windowsArtifacts -Filter "*.zip" | ForEach-Object {
    tar -tf $_.FullName *> $null
    if ($LASTEXITCODE -ne 0) { throw "Invalid ZIP: $($_.Name)" }
}

Get-ChildItem -LiteralPath $releaseRoot -Recurse -File | Get-FileHash -Algorithm SHA256
```

- Confirm the AppImage begins with the ELF header `7F 45 4C 46`.
- Confirm the Windows build and Linux build both logged the `beta` source clone. Do not inspect or manually edit `resources/social_stream_fallback`; it is generated by the build.

### 8. Write the release notes

- Use the established format in the next section of this file.
- For an early build, use an explicit title such as `v0.4.12 PRE-RELEASE — Untested Build`.
- Put the export-settings warning first.
- State plainly that the build has not completed broad real-world testing and may contain issues.
- Summarize all important user-facing changes since the previous release.
- Include the standard screenshot and a downloads table containing only files that will actually be uploaded.

### 9. Publish only to Social Stream

Create the tag and pre-release in `steveseguin/social_stream`, targeting `beta`:

```powershell
gh release create "v$version" `
    "$windowsArtifacts/socialstreamninja-setup-$version.exe" `
    "$windowsArtifacts/socialstreamninja-portable.exe" `
    "$windowsArtifacts/socialstreamninja_win_v${version}_installer.zip" `
    "$windowsArtifacts/socialstreamninja_win_v${version}_portable.zip" `
    "$linuxArtifacts/socialstreamninja_linux_v${version}_x86_64.AppImage" `
    -R steveseguin/social_stream `
    --target beta `
    --title "v$version PRE-RELEASE — Untested Build" `
    --notes-file RELEASE_NOTES.md `
    --prerelease
```

Never run this command against `steveseguin/ssn_app`.

### 10. Verify the public release

```powershell
gh release view "v$version" -R steveseguin/social_stream --json name,tagName,isPrerelease,isDraft,targetCommitish,url,body,assets
```

Confirm all of the following:

- The title explicitly says `PRE-RELEASE` and `Untested Build` when requested.
- `isPrerelease` is `true` and `isDraft` is `false`.
- The target is `beta`.
- Every expected file is in the `uploaded` state and its byte size matches the local file.
- The download links point to `steveseguin/social_stream/releases/download/...`.
- Important source fixes exist at the release tag, not merely on a later branch commit.
- Both local repositories are clean after the release.

### Current GitHub Actions warning

The `release-builds.yml` numbered build currently runs Windows and Linux successfully, but its fallback updater defaults to `social_stream/main`. Do not use those numbered-build artifacts for a beta-backed release unless the workflow is changed or its logs prove that it cloned `social_stream.git#beta` and wrote that source into the bundled `main` fallback.

The manual commands above are the known-good process used for v0.4.12.

## Build Artifacts

Run Windows builds from `ssapp`:

```powershell
npm run build:win32
```

To package the current Social Stream `beta` branch as the app's `main` fallback for a numbered release:

```powershell
$env:SSN_SOCIALSTREAM_BRANCH = "beta"
$env:SSN_SOCIALSTREAM_OUTPUT_BRANCH = "main"
npm run build:win32
```

Expected Windows artifacts are written under `dist/`, including:

```txt
socialstreamninja-setup-<version>.exe
socialstreamninja-portable.exe
socialstreamninja_win_v<version>_installer.zip
socialstreamninja_win_v<version>_portable.zip
```

## VirusTotal

- Keep the local VirusTotal key in `.secret` at the repo root as `VT_API_KEY=...`.
- `.secret` must stay gitignored and must not be committed.
- After the Windows build, submit only the two Windows `.exe` files to VirusTotal:
  - `dist/socialstreamninja-setup-<version>.exe`
  - `dist/socialstreamninja-portable.exe`
- Use:

```powershell
npm run submit:virustotal
```

- The submit script reads `VT_API_KEY` from the environment first, then from `.secret`.
- The GitHub workflow also has a Windows-only VirusTotal submission step using the `VT_API_KEY` GitHub secret.
- Do not submit Linux AppImage builds to VirusTotal.

## Platform Build Order

1. Build Windows in `ssapp`.
2. Submit the Windows installer and portable `.exe` files to VirusTotal.
3. Upload the Windows artifacts to the `steveseguin/social_stream` GitHub release.
4. Build the Linux AppImage via WSL2 after the Windows build is finished.
5. Upload the Linux AppImage to the same `steveseguin/social_stream` GitHub release.
6. Steve handles macOS builds for now.

## Proper Release Flow

1. Confirm the requested release version and target with Steve.
2. Make and test the `ssapp` code changes.
3. Commit and push `ssapp` code changes if Steve asked to push; include all dirty tracked changes unless Steve explicitly excludes something.
4. Build release artifacts in `ssapp`.
5. Submit the Windows installer and portable `.exe` files to VirusTotal.
6. Publish tags and artifacts to `steveseguin/social_stream`, not `steveseguin/ssn_app`; mark the GitHub release as a pre-release.
7. Verify the public release/download URLs point at `steveseguin/social_stream/releases`.

## GitHub Release Notes

Release notes must be written for normal users, not developers.

Always start with:

```md
:point_right::point_right: EXPORT AND SAVE YOUR SETTINGS BEFORE UPDATING :warning::warning:
```

Then include:

```md
### What's new in this version:
**v<version>**
- Short user-facing bullet.
- Short user-facing bullet.
- Short user-facing bullet.

<img src="https://github.com/user-attachments/assets/19585745-bee0-45e4-8719-43d8f715609d" height="200">
```

Rules for the notes:

- Follow the existing Social Stream release-note style, including the heading `### What's new in this version:`.
- The `What's new` bullets must summarize every important user-facing change included in the release package, not only the final version bump. If `v0.3.128` is being released after `v0.3.113`, include the important user-facing changes from `v0.3.114` through `v0.3.128`.
- Check recent `steveseguin/social_stream` releases before writing notes so the wording and layout match the existing style.
- Include only important changes a non-technical user would care about.
- Use plain, easy language.
- Do not include internal implementation details unless they explain a visible fix.
- Do not say "Windows, macOS, and Linux pre-release".
- Do not say "This pre-release includes Windows, macOS, and Linux builds."
- Include the screenshot image above so users see what to press.
- Include a downloads table with the uploaded files.

## Do Not

- Do not run `git tag` in `ssapp` for app releases.
- Do not run `gh release create` or `gh release upload` against `steveseguin/ssn_app`.
- Do not assume `package.json`'s GitHub publish provider means `ssn_app` is the public release target.
- Do not touch `resources/social_stream_fallback` manually as part of release cleanup; it is generated by the build/update process.

## If A Wrong ssapp Tag Or Release Is Created

Stop and report it to Steve before cleanup.

The likely cleanup target is `steveseguin/ssn_app`, not `steveseguin/social_stream`, but do not delete tags/releases without Steve's explicit approval.

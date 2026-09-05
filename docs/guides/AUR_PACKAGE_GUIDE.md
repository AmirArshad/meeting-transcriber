# Arch User Repository (AUR) Packaging Guide

This guide explains how to package, test, publish, and maintain AvaNevis on the Arch User Repository (AUR) for Arch Linux and Arch-based distributions (Omarchy, CachyOS, EndeavourOS, Manjaro, etc.).

---

## Overview

AvaNevis produces an official pacman package (`AvaNevis-Setup-<version>.pkg.tar.zst`) in each GitHub Release, containing the bundled Python 3.11 standalone runtime, ffmpeg, Electron application files, and desktop integrations.

Per [Arch packaging standards](https://wiki.archlinux.org/title/Arch_User_Repository#Rules_of_submission), packages that repackage pre-built upstream binaries must be named with the **`-bin`** suffix. Therefore, the official package name on the AUR is:

```
avanevis-bin
```

This package:
- Downloads the official `AvaNevis-Setup-${pkgver}.pkg.tar.zst` from GitHub Releases.
- Extracts and installs the payload into `/opt/AvaNevis` and `/usr/share/`.
- Links `/opt/AvaNevis/avanevis` into `/usr/bin/avanevis` for command-line access.
- Installs the MIT license under `/usr/share/licenses/avanevis-bin/LICENSE`.
- Declares `provides=('avanevis')` and `conflicts=('avanevis')`.

---

## Initial Setup (One-Time)

### 1. Register on the AUR

1. Create an account at [aur.archlinux.org](https://aur.archlinux.org/).
2. In your account settings, add your public SSH key (`~/.ssh/id_ed25519.pub` or `~/.ssh/id_rsa.pub`).
3. (Recommended) Configure SSH in `~/.ssh/config`:
   ```sshconfig
   Host aur.archlinux.org
       User aur
       IdentityFile ~/.ssh/id_ed25519
   ```

### 2. Install Arch Packaging Tools

On your Arch/CachyOS/Omarchy workstation:
```bash
sudo pacman -S --needed base-devel git pacman-contrib
```

### 3. Clone the Package Repository

AUR creates a new Git repository on first push. Clone the empty namespace:
```bash
git clone ssh://aur@aur.archlinux.org/avanevis-bin.git
cd avanevis-bin
```

---

## Package Files

The AUR package requires two files: `PKGBUILD` and `.SRCINFO`.

### `PKGBUILD`

Create `PKGBUILD` in the repository root:

```bash
# Maintainer: Amir Arshad <amir.arshad.dev@gmail.com>

pkgname=avanevis-bin
pkgver=2.9.0
pkgrel=1
pkgdesc="Private meeting recorder and local AI transcriber"
arch=('x86_64')
url="https://github.com/AmirArshad/meeting-transcriber"
license=('MIT')
depends=(
  'alsa-lib'
  'at-spi2-core'
  'dbus'
  'gtk3'
  'libnotify'
  'libpulse'
  'libsecret'
  'libxss'
  'libxtst'
  'nss'
  'xdg-utils'
)
optdepends=(
  'cuda: Optional GPU acceleration for Whisper transcription, Speakrs, and local summaries on NVIDIA GPUs'
)
provides=('avanevis')
conflicts=('avanevis')
source=("https://github.com/AmirArshad/meeting-transcriber/releases/download/v${pkgver}/AvaNevis-Setup-${pkgver}.pkg.tar.zst")
sha256sums=('af2eded1d633a20c354508536642eb1542baeef59dc6a4655ea755f08701e5ba')

package() {
  # Copy packaged payload into the package destination
  cp -dr --no-preserve=ownership opt usr "$pkgdir/"

  # Create executable symlink in /usr/bin tracked by pacman
  install -dm755 "$pkgdir/usr/bin"
  ln -sf /opt/AvaNevis/avanevis "$pkgdir/usr/bin/avanevis"

  # Install license
  install -Dm644 "$pkgdir/opt/AvaNevis/resources/legal/LICENSE.txt" \
    "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
}
```

### Generating `.SRCINFO`

The `.SRCINFO` file is parsed directly by the AUR web platform and AUR helpers (`yay`, `paru`). Never edit it manually; generate it using `makepkg`:

```bash
makepkg --printsrcinfo > .SRCINFO
```

---

## Local Verification

Before submitting or updating the AUR package, test building and installing locally:

```bash
# Build and install dependencies, then install package locally
makepkg -si

# Verify the app launches and works
avanevis

# Test removing cleanly
sudo pacman -R avanevis-bin
```

---

## Publishing to the AUR

Commit only `PKGBUILD` and `.SRCINFO` (do not commit build artifacts, tarballs, or temporary directories):

```bash
git add PKGBUILD .SRCINFO
git commit -m "Release v2.9.0"
git push origin master
```

Once pushed, the package will immediately be live at:
`https://aur.archlinux.org/packages/avanevis-bin`

Users can install it with:
```bash
yay -S avanevis-bin
# or
paru -S avanevis-bin
```

---

## Maintaining Future Releases

For subsequent releases (e.g. `2.9.1`):

1. **Update `pkgver`:**
   Edit `pkgver=2.9.1` and reset `pkgrel=1` in `PKGBUILD`.

2. **Update checksums:**
   Run `updpkgsums` to automatically download the new release and replace `sha256sums`:
   ```bash
   updpkgsums
   ```
   *(Or manually calculate: `curl -sL <url> | sha256sum` and update `sha256sums`).*

3. **Regenerate `.SRCINFO`:**
   ```bash
   makepkg --printsrcinfo > .SRCINFO
   ```

4. **Test build locally:**
   ```bash
   makepkg -si
   ```

5. **Commit and push:**
   ```bash
   git add PKGBUILD .SRCINFO
   git commit -m "Update to v2.9.1"
   git push origin master
   ```

---

## CI/CD Automation (GitHub Actions)

To automate AUR publishing upon new GitHub Releases:

1. Generate a dedicated SSH key pair:
   ```bash
   ssh-keygen -t ed25519 -C "github-actions-aur@avanevis" -f ~/.ssh/aur_deploy_key
   ```
2. Add the public key (`~/.ssh/aur_deploy_key.pub`) to your AUR profile.
3. Add the private key (`~/.ssh/aur_deploy_key`) to GitHub repo secrets as `AUR_SSH_PRIVATE_KEY`.
4. Add a job in `.github/workflows/build-release.yml` using `KSXGitHub/github-actions-deploy-aur@v3` or an equivalent automated push step after release assets are published.

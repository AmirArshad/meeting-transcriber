# Initiative: AUR Packaging and Release Automation

- **Status:** In progress (v2.9.0 manual publication baseline; CI automation planned)
- **Target Package:** `avanevis-bin` on the Arch User Repository (AUR)
- **Target Distros:** Arch Linux, Omarchy 4, CachyOS, Manjaro, EndeavourOS, and Arch-family distributions

---

## Background & Motivation

AvaNevis v2.8.0 introduced Linux Core Beta support with native `pacman` packages (`AvaNevis-Setup-<version>.pkg.tar.zst`). While users can manually download this asset and install it using `sudo pacman -U`, the standard and preferred software distribution method on Arch-based distributions is the Arch User Repository (AUR).

Publishing `avanevis-bin` to the AUR:
1. Enables one-command installation and upgrades via popular AUR helpers (`yay -S avanevis-bin`, `paru -S avanevis-bin`).
2. Automatically resolves system dependencies (`alsa-lib`, `gtk3`, `libpulse`, `libsecret`, `nss`, etc.).
3. Notifies users of updates during regular system upgrade cycles (`yay -Syu`).
4. Drastically improves discoverability for Arch and CachyOS users.

---

## Scope & Decisions

### 1. Binary Package (`avanevis-bin`) vs Source Build (`avanevis`)
- **Decision:** Package as **`avanevis-bin`**, consuming the official GitHub release `AvaNevis-Setup-${pkgver}.pkg.tar.zst`.
- **Rationale:** Building from source requires Node.js, Electron toolchain, bundled Python 3.11 standalone environment, ffmpeg compliance assets, and complex resource staging. The binary package matches Arch packaging standards for vendor-packaged binary distributions and guarantees identical behavior and verified dependencies.

### 2. Implementation Milestones

#### Phase 1: Manual Package Publication (v2.9.0)
- [x] Construct idiomatic, verified `PKGBUILD` for `avanevis-bin` using v2.9.0 release assets.
- [x] Verify package creation, dependency resolution, symlinks, and license placement with `makepkg`.
- [x] Provide maintainer operational guide in [`docs/guides/AUR_PACKAGE_GUIDE.md`](../guides/AUR_PACKAGE_GUIDE.md).
- [ ] Claim `avanevis-bin` on `aur.archlinux.org` by pushing the initial `PKGBUILD` and `.SRCINFO`.
- [ ] Perform live smoke test installation on CachyOS / Omarchy using `yay` / `paru`.

#### Phase 2: Release Workflow Automation (Future Release)
- [ ] Configure dedicated deploy SSH key in AUR profile and GitHub repository secrets (`AUR_SSH_PRIVATE_KEY`).
- [ ] Add an automated `publish-aur` job to `.github/workflows/build-release.yml`.
- [ ] Automatically calculate checksums, generate `.SRCINFO`, and push to `aur@aur.archlinux.org:avanevis-bin.git` when a GitHub release is finalized.
- [ ] Guard against partial or failed release uploads: ensure AUR publishing runs only after release assets are successfully attached and verified.

---

## References

- [AUR Packaging Guide](../guides/AUR_PACKAGE_GUIDE.md)
- [Linux Support Architecture](LINUX_SUPPORT.md)
- [Linux Experimental Beta Distro Guide](../guides/LINUX_EXPERIMENTAL.md)
- [Release Workflow](../../.github/workflows/build-release.yml)

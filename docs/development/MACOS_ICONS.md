# macOS Icon Requirements

> **Linux tray icons live elsewhere.** Linux uses `build/iconTrayLinux.png` (idle) and `build/iconTrayLinuxRecording.png` (recording), both 64×64 full-colour PNGs staged through `build.extraResources`. They are **not** template images and must not be replaced with `icon.ico` — `nativeImage.createFromPath` returns an empty image for `.ico` outside Windows, and `new Tray(emptyImage)` still succeeds on Linux, so the failure is a silently blank tray entry. Regenerate with ImageMagick:
>
> ```bash
> magick build/icons/256x256.png -filter Lanczos -resize 64x64 -strip build/iconTrayLinux.png
> magick -size 64x64 xc:none \
>   \( build/icons/256x256.png -filter Lanczos -resize 48x48 \) -geometry +0+0 -composite \
>   \( build/recording-overlay.png -filter Lanczos -resize 34x34 \) -geometry +30+30 -composite \
>   -depth 8 -define png:color-type=6 -strip build/iconTrayLinuxRecording.png
> ```
>
> Filenames are pinned by `resolveTrayImageFileName` in `src/main/recording-presence-service.js` and asserted in `tests/js/recording-presence-service.test.js`.

## Tray Icons (Menu Bar)

For macOS menu bar (tray) icons, you need **Template Images** that automatically adapt to light/dark mode.

### Required Files

1. **iconTemplate.png** (16x16 pixels)
   - Standard resolution for menu bar
   - Black and transparent only
   - Black areas will be inverted in dark mode

2. **iconTemplate@2x.png** (32x32 pixels)
   - Retina display support
   - Same design as 16x16, just higher resolution

### Design Guidelines

**Template Image Rules:**
- Use **black (#000000) and transparent** only
- No colors, no gradients
- File name MUST end with `Template.png` for macOS to recognize it
- macOS will automatically:
  - Render as white in dark mode
  - Render as black in light mode
  - Apply system-standard styling

**Design Tips:**
- Keep it simple (it's tiny - 16x16!)
- Use clear, recognizable shapes
- Test at actual size (zoom way out in design tool)
- Ensure it works in both light and dark mode

### Icon Ideas for AvaNevis

Option 1: **Microphone Icon**
```
Simple mic silhouette (what we likely have in the current .ico)
```

Option 2: **Waveform**
```
Three vertical bars of different heights (audio equalizer style)
```

Option 3: **Speech Bubble with Mic**
```
Chat bubble with small mic inside
```

### Creating the Icons

#### From Existing .ico File (Recommended)

If `icon.ico` already has a good design:

1. Open `icon.ico` in an image editor (Photoshop, GIMP, etc.)
2. Extract the 16x16 and 32x32 layers
3. Convert to **black and transparent** only:
   - Desaturate (remove all color)
   - Increase contrast to pure black
   - Remove any gray (should be 100% black or 100% transparent)
4. Save as PNG:
   - 16x16 → `iconTemplate.png`
   - 32x32 → `iconTemplate@2x.png`
5. Place in `build/` directory

#### From Scratch

Use any design tool:
- Figma, Sketch, Adobe XD (professional)
- Pixelmator, Affinity Designer (Mac-specific)
- GIMP, Photoshop (cross-platform)

Export settings:
- Format: PNG
- Transparency: Yes
- Color mode: Grayscale or RGB (but only use black)
- Naming: MUST include "Template" in filename

### Online Tools (Quick Option)

1. **CloudConvert** (https://cloudconvert.com/ico-to-png)
   - Convert .ico to .png
   - Download 16x16 and 32x32 versions

2. **Remove Color** (any image editor)
   - Convert to grayscale
   - Adjust levels to pure black/transparent

3. **Rename**
   - Add "Template" to filename

### Verifying Your Icons

```bash
# Check file size (should be small - just black and transparent)
ls -lh build/iconTemplate*.png

# Quick visual check on Mac
qlmanage -p build/iconTemplate.png
qlmanage -p build/iconTemplate@2x.png

# Test in app - should adapt to light/dark mode automatically
```

### Installation in Project

Once you have the files:

1. Place in `build/` directory:
   ```
   build/
   ├── icon.ico (existing - for Windows)
   ├── iconTemplate.png (NEW - 16x16 for macOS)
   └── iconTemplate@2x.png (NEW - 32x32 for macOS Retina)
   ```

2. The updated `createTray()` function will automatically use them on macOS

### App Icon vs Tray Icon

**Don't confuse these two:**

- **Tray/Menu Bar Icon** (what we're creating):
  - Goes in macOS menu bar (top-right)
  - 16x16 / 32x32 pixels
  - Black and transparent template
  - Files: `iconTemplate.png`, `iconTemplate@2x.png`

- **App Icon** (different, for Phase 6):
  - Goes in Dock when app is running
  - Goes in Applications folder
  - 512x512 pixels (or larger)
  - Full color, with macOS style
  - File: `icon.icns` (special macOS format)

We're only creating **tray icons** for now. The app icon can be created in Phase 6.

---

## Quick Start (For Testing)

**If you just want to test quickly:**

1. Create a simple 16x16 black square:
   ```
   Any image editor → 16x16 canvas → Draw a black circle or mic shape → Save as iconTemplate.png
   ```

2. Duplicate and resize to 32x32:
   ```
   Save as iconTemplate@2x.png
   ```

3. Place both in `build/` folder

4. Run the app on macOS - you should see the icon in the menu bar!

The icon will look basic, but it proves the functionality works. You can always make a prettier version later.

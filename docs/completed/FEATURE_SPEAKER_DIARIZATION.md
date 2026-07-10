# Feature: Speaker Diarization (Who Spoke When)

> **Historical design doc.** Speaker diarization shipped as an optional local AI add-on. Implementation lives under `src/main/ai-addon-ipc.js`, `src/ai-addon-setup.js` / `src/ai-addon/`, `src/ai-addon-token-store.js`, and `backend/diarization/`. Do not treat “add handlers to `src/main.js`” sections below as the current layout — see root `AGENTS.md` and `docs/development/LOCAL_AI_MODEL_CATALOG.md`.

## Overview

Add speaker identification to transcripts so users can see which person said what during meetings with multiple participants.

Product-flow design for optional setup, Home prompts, automatic speaker-guided transcription, and History integration lives in [Optional local AI add-ons](DESIGN_LOCAL_AI_ADDONS.md).

## 2026 Research Update

The original design targeted `pyannote/speaker-diarization-3.1`. Current research favors `pyannote/speaker-diarization-community-1` as the default local model.

Recommended defaults:

| Target | Recommended model | Runtime | Notes |
|--------|-------------------|---------|-------|
| Windows default | `pyannote/speaker-diarization-community-1` | `pyannote.audio` / PyTorch CUDA | Best implementation fit, improved speaker counting/assignment over 3.1, local after download. |
| macOS target | `pyannote/speaker-diarization-community-1` | `pyannote.audio` / PyTorch Metal/MPS on Apple Silicon | Setup and runtime require MPS; otherwise use the current transcription-only flow. |
| Windows CUDA spike | `nvidia/diar_streaming_sortformer_4spk-v2.1` | NVIDIA NeMo / PyTorch CUDA | Fast and meeting-speech-focused, but heavier dependencies, max 4 speakers, and weak macOS fit. |
| CPU/lower-end fallback | Not shipped in v1 | None | Keep the current transcription-only flow instead of running slow CPU diarization. |

Important changes from the old plan:

- `community-1` adds `exclusive_speaker_diarization`, which assigns one active speaker at any timestamp and simplifies merging with Whisper transcript segments.
- The model is gated on Hugging Face and still requires user acceptance plus a token.
- Windows should use CUDA when available.
- macOS should only expose diarization on Apple Silicon and must validate PyTorch Metal/MPS before setup becomes ready. If MPS is unavailable or validation fails, keep the current transcription-only flow rather than shipping CPU-only diarization in v1.
- Disable optional pyannote metrics in app-spawned processes with `PYANNOTE_METRICS_ENABLED=0` to preserve AvaNevis' local-only/no-telemetry posture.

Decision status: use `community-1` for v1 unless a Windows-only Sortformer spike proves a major quality or performance win without unacceptable packaging cost.

## Implementation Snapshot

- The current backend entry points are `backend/diarization/guided_transcription.py` for new speaker-guided recordings and `backend/diarization/diarization_pipeline.py` for legacy/post-hoc speaker merging.
- Electron invokes `transcribe-audio-with-speakers` when setup status is Ready. This runs pyannote first, builds padded speaker turns, transcribes those windows with Whisper, and saves speaker-labeled chunks.
- The main process resolves the pyannote model reference from the catalog and ignores renderer-supplied model refs.
- The main process passes a required accelerator device to the backend (`cuda` on Windows, `mps` on macOS Apple Silicon). The backend refuses CPU fallback when a required device is unavailable.
- Diarization, guided transcription, plain `transcribe-audio`, and summary generation share one main-process compute queue with wall-clock timeouts so a hung subprocess cannot block later jobs for the rest of the session. Whisper model download/preload stays off that queue.
- The runner prepares uncompressed 16 kHz mono PCM WAV input, sets `PYANNOTE_METRICS_ENABLED=0`, loads the pyannote model from local cache only during actual diarization, uses bounded in-memory audio input for shorter recordings, falls back to file-path input for longer recordings, prefers `exclusive_speaker_diarization`, writes a `*.speakers.json` sidecar, and returns redacted progress events.
- The Hugging Face token is used for setup and validation of the gated pyannote model. Once setup is ready and the model is cached, actual diarization runs offline without reading the stored token; removing the token after setup does not disable existing cached speaker identification, but setup repair or re-download requires a token again.
- Renderer saves guided Markdown with `**Speaker N:**` labels when the guided path succeeds. If it fails, the app falls back to normal transcription and records diarization error metadata.
- History parses saved transcript Markdown so speaker labels remain visible after restart.
- Failure is warning-only: the normal transcript remains saved and meeting metadata records the diarization error without token values.
- Audio and speaker sidecar paths are checked in the main process so derived AI metadata remains inside the recordings directory.

## Problem Being Solved

Current transcription output shows what was said, but not who said it:

```markdown
[00:00:00 - 00:00:05] Hello everyone, welcome to the meeting.
[00:00:05 - 00:00:10] Thanks for having me, excited to be here.
[00:00:10 - 00:00:15] Let's get started with the agenda.
```

This makes it hard to follow conversations with multiple speakers.

## Solution: Integrate pyannote.audio Community-1

Combine Whisper (transcription) with pyannote.audio (speaker diarization) to label speakers:

```markdown
[00:00:00 - 00:00:05] **Speaker 1:** Hello everyone, welcome to the meeting.
[00:00:05 - 00:00:10] **Speaker 2:** Thanks for having me, excited to be here.
[00:00:10 - 00:00:15] **Speaker 1:** Let's get started with the agenda.
```

---

## Architecture

### Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| When to run | Before transcription when setup is ready | Speaker turns shape Whisper chunks instead of labeling large transcript chunks after the fact |
| Token storage | Electron `safeStorage` | OS keychain encryption, persists across reinstalls |
| Platform code | Single implementation first | `pyannote.audio` keeps one backend for Windows + macOS; Sortformer can remain a Windows CUDA experiment |
| Default diarization model | `pyannote/speaker-diarization-community-1` | Current open-source pyannote model, better than 3.1, supports exclusive diarization for transcript alignment |
| v1 scope | Speaker 1/2/3 labels | Custom naming deferred to v2 |

### File Structure

```
backend/
├── diarization/                     # NEW MODULE
│   ├── __init__.py
│   ├── speaker_diarizer.py          # Core pyannote logic (lazy-loaded)
│   └── diarize_transcript.py        # CLI entry point for IPC
├── transcription/
│   └── ...                          # Existing transcribers (unchanged)
```

### Pipeline Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    DIARIZATION FIRST                             │
│  Opus file → pyannote → exclusive speaker turns                 │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    SPEAKER-GUIDED TRANSCRIPTION                  │
│                                                                  │
│  1. Build padded speaker windows from diarization turns         │
│  2. Transcribe each window with Whisper                         │
│  3. Drop padded context when Whisper timestamps allow it         │
│  4. Save speaker-labeled transcript and sidecar                 │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    OUTPUT                                        │
│  Markdown with [timestamp] **Speaker N:** text                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Technical Implementation

### Dependencies

```bash
# Add to requirements-windows.txt and requirements-macos.txt after platform validation
pyannote.audio>=4.0.0  # Validate packaged Python 3.11 compatibility before pinning
torch>=2.0.0           # Required by pyannote; CUDA on Windows, validated acceleration on macOS
```

**Hugging Face Setup (user must do once):**
1. Sign up at https://huggingface.co/
2. Get token from https://huggingface.co/settings/tokens
3. Accept model terms at https://huggingface.co/pyannote/speaker-diarization-community-1

Users must provide their own Hugging Face token. Do not ship a maintainer-owned token in the app or hide one behind an AvaNevis service; desktop app secrets are extractable, and a shared token would create account, quota, revocation, and model-term compliance risk.

### Backend: `speaker_diarizer.py`

```python
"""
Speaker diarization using pyannote.audio.

Lazy-loads the model on first use to avoid startup overhead.
Handles Opus → WAV conversion internally.
"""

import os
import sys
import subprocess
import tempfile
from pathlib import Path
from typing import List, Dict, Any, Optional

# Lazy imports - only load when needed
_pipeline = None


def _get_pipeline(hf_token: str, device: str = "auto"):
    """Lazy-load the pyannote pipeline."""
    global _pipeline
    if _pipeline is None:
        print("Loading speaker diarization model...", file=sys.stderr)

        import torch
        from pyannote.audio import Pipeline

        os.environ.setdefault("PYANNOTE_METRICS_ENABLED", "0")

        if device == "auto":
            if torch.cuda.is_available():
                device = "cuda"
            elif torch.backends.mps.is_built() and torch.backends.mps.is_available():
                device = "mps"  # macOS Metal
            else:
                raise RuntimeError("Speaker diarization requires CUDA or Metal/MPS acceleration.")

        _pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-community-1",
            token=hf_token
        )
        _pipeline.to(torch.device(device))
        print(f"Model loaded on {device}", file=sys.stderr)

    return _pipeline


def _convert_opus_to_wav(opus_path: str) -> str:
    """Convert Opus to WAV for pyannote (requires WAV input)."""
    wav_path = tempfile.mktemp(suffix=".wav")

    subprocess.run([
        "ffmpeg", "-i", opus_path,
        "-ar", "16000",  # pyannote expects 16kHz
        "-ac", "1",      # mono
        "-y", wav_path
    ], check=True, capture_output=True)

    return wav_path


def diarize(
    audio_path: str,
    hf_token: str,
    num_speakers: Optional[int] = None,
    device: str = "auto"
) -> List[Dict[str, Any]]:
    """
    Identify speakers in audio file.

    Args:
        audio_path: Path to audio file (.opus or .wav)
        hf_token: Hugging Face API token
        num_speakers: Expected number of speakers (None = auto-detect)
        device: "auto", "cuda", or "mps"; CPU fallback is not shipped in v1

    Returns:
        List of segments: [{'start': float, 'end': float, 'speaker': str}, ...]
    """
    temp_wav = None

    try:
        # Convert Opus to WAV if needed
        if audio_path.endswith('.opus'):
            print("Converting Opus to WAV...", file=sys.stderr)
            temp_wav = _convert_opus_to_wav(audio_path)
            audio_path = temp_wav

        # Run diarization
        pipeline = _get_pipeline(hf_token, device)

        print("Running speaker diarization...", file=sys.stderr)
        output = pipeline(audio_path, num_speakers=num_speakers)

        # Community-1 exposes exclusive diarization for easier STT alignment.
        diarization = getattr(output, "exclusive_speaker_diarization", None)
        if diarization is None:
            diarization = output.speaker_diarization

        # Extract segments
        segments = []
        for turn, speaker in diarization:
            segments.append({
                'start': turn.start,
                'end': turn.end,
                'speaker': speaker
            })

        print(f"Found {len(set(s['speaker'] for s in segments))} speakers", file=sys.stderr)
        return segments

    finally:
        # Always clean up temp WAV
        if temp_wav and os.path.exists(temp_wav):
            os.remove(temp_wav)
            print("Cleaned up temp WAV", file=sys.stderr)


def merge_with_transcription(
    transcription_segments: List[Dict[str, Any]],
    speaker_segments: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """
    Merge Whisper transcription with speaker diarization.

    For each transcription segment, find the speaker with the most
    temporal overlap and add the speaker label.
    """
    # Normalize speaker labels to "Speaker 1", "Speaker 2", etc.
    unique_speakers = sorted(set(s['speaker'] for s in speaker_segments))
    speaker_map = {sp: f"Speaker {i+1}" for i, sp in enumerate(unique_speakers)}

    for trans_seg in transcription_segments:
        best_speaker = None
        best_overlap = 0

        for spk_seg in speaker_segments:
            # Calculate overlap
            overlap_start = max(trans_seg['start'], spk_seg['start'])
            overlap_end = min(trans_seg['end'], spk_seg['end'])
            overlap = max(0, overlap_end - overlap_start)

            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = spk_seg['speaker']

        trans_seg['speaker'] = speaker_map.get(best_speaker, "Unknown")

    return transcription_segments
```

### Backend: `diarize_transcript.py` (CLI Entry Point)

```python
"""
CLI entry point for speaker diarization.

Usage:
    python diarize_transcript.py --audio recording.opus --segments segments.json --token hf_xxx --json
"""

import argparse
import json
import sys
from pathlib import Path

from .speaker_diarizer import diarize, merge_with_transcription


def main():
    parser = argparse.ArgumentParser(description="Add speaker labels to transcript")
    parser.add_argument("--audio", required=True, help="Path to audio file")
    parser.add_argument("--segments", required=True, help="Path to JSON file with transcription segments")
    parser.add_argument("--token", required=True, help="Hugging Face API token")
    parser.add_argument("--num-speakers", type=int, default=None, help="Expected number of speakers")
    parser.add_argument("--json", action="store_true", help="Output as JSON")
    args = parser.parse_args()

    # Load transcription segments
    with open(args.segments, 'r') as f:
        transcription_segments = json.load(f)

    try:
        # Run diarization
        speaker_segments = diarize(
            args.audio,
            args.token,
            num_speakers=args.num_speakers
        )

        # Merge with transcription
        labeled_segments = merge_with_transcription(
            transcription_segments,
            speaker_segments
        )

        # Output
        result = {
            'success': True,
            'segments': labeled_segments,
            'num_speakers': len(set(s['speaker'] for s in labeled_segments))
        }

        if args.json:
            print(json.dumps(result))
        else:
            for seg in labeled_segments:
                print(f"[{seg['start']:.2f} - {seg['end']:.2f}] {seg['speaker']}: {seg['text']}")

    except Exception as e:
        if args.json:
            print(json.dumps({'success': False, 'error': str(e)}))
        else:
            print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
```

### Electron: IPC Handlers

Add to `src/main.js`:

```javascript
// ============================================================================
// Secure Token Storage (for HF token)
// ============================================================================

const { safeStorage } = require('electron');

/**
 * Store a token securely using OS keychain
 */
ipcMain.handle('store-secure-token', async (event, { key, token }) => {
  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback: store in userData (less secure)
    const tokenPath = path.join(app.getPath('userData'), `.${key}`);
    fs.writeFileSync(tokenPath, token, 'utf8');
    return { success: true, encrypted: false };
  }

  const encrypted = safeStorage.encryptString(token);
  const tokenPath = path.join(app.getPath('userData'), `.${key}.enc`);
  fs.writeFileSync(tokenPath, encrypted);
  return { success: true, encrypted: true };
});

/**
 * Retrieve a securely stored token
 */
ipcMain.handle('get-secure-token', async (event, { key }) => {
  // Try encrypted first
  const encPath = path.join(app.getPath('userData'), `.${key}.enc`);
  if (fs.existsSync(encPath) && safeStorage.isEncryptionAvailable()) {
    const encrypted = fs.readFileSync(encPath);
    return { token: safeStorage.decryptString(encrypted), encrypted: true };
  }

  // Fallback to plain
  const plainPath = path.join(app.getPath('userData'), `.${key}`);
  if (fs.existsSync(plainPath)) {
    return { token: fs.readFileSync(plainPath, 'utf8'), encrypted: false };
  }

  return { token: null };
});

/**
 * Delete a stored token
 */
ipcMain.handle('delete-secure-token', async (event, { key }) => {
  const encPath = path.join(app.getPath('userData'), `.${key}.enc`);
  const plainPath = path.join(app.getPath('userData'), `.${key}`);

  if (fs.existsSync(encPath)) fs.unlinkSync(encPath);
  if (fs.existsSync(plainPath)) fs.unlinkSync(plainPath);

  return { success: true };
});

// ============================================================================
// Speaker Diarization
// ============================================================================

/**
 * Add speaker labels to an existing transcript
 */
ipcMain.handle('diarize-transcript', async (event, options) => {
  const { audioFile, segments, hfToken, numSpeakers } = options;

  // Write segments to temp file
  const segmentsPath = path.join(app.getPath('temp'), 'segments.json');
  fs.writeFileSync(segmentsPath, JSON.stringify(segments));

  return new Promise((resolve, reject) => {
    const args = [
      path.join(pythonConfig.backendPath, 'diarization', 'diarize_transcript.py'),
      '--audio', audioFile,
      '--segments', segmentsPath,
      '--token', hfToken,
      '--json'
    ];

    if (numSpeakers) {
      args.push('--num-speakers', numSpeakers.toString());
    }

    const python = spawnTrackedPython(args);

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
      mainWindow.webContents.send('diarization-progress', data.toString());
    });

    python.on('close', (code) => {
      // Clean up temp file
      if (fs.existsSync(segmentsPath)) fs.unlinkSync(segmentsPath);

      try {
        const result = JSON.parse(output);
        if (result.success) {
          resolve(result);
        } else {
          reject(new Error(result.error || 'Diarization failed'));
        }
      } catch (e) {
        reject(new Error(`Diarization failed: ${errorOutput || 'Unknown error'}`));
      }
    });
  });
});

/**
 * Test if HF token is valid for pyannote
 */
ipcMain.handle('test-hf-token', async (event, { token }) => {
  return new Promise((resolve) => {
    const python = spawnTrackedPython([
      '-c',
      `
import sys
try:
    from huggingface_hub import HfApi
    api = HfApi()
    api.whoami(token="${token}")
    print('{"valid": true}')
except Exception as e:
    print('{"valid": false, "error": "' + str(e).replace('"', "'") + '"}')
`
    ]);

    let output = '';
    python.stdout.on('data', (data) => { output += data.toString(); });
    python.on('close', () => {
      try {
        resolve(JSON.parse(output));
      } catch {
        resolve({ valid: false, error: 'Failed to validate token' });
      }
    });
  });
});
```

### Electron: Preload Bridge

Add to `src/preload.js`:

```javascript
// Secure token storage
storeSecureToken: (key, token) => ipcRenderer.invoke('store-secure-token', { key, token }),
getSecureToken: (key) => ipcRenderer.invoke('get-secure-token', { key }),
deleteSecureToken: (key) => ipcRenderer.invoke('delete-secure-token', { key }),

// Speaker diarization
diarizeTranscript: (options) => ipcRenderer.invoke('diarize-transcript', options),
testHfToken: (token) => ipcRenderer.invoke('test-hf-token', { token }),
onDiarizationProgress: (callback) => ipcRenderer.on('diarization-progress', (event, data) => callback(data)),
```

---

## UI Integration

### Settings Section

Add to Settings panel in `index.html`:

```html
<div class="settings-section">
  <h3>Speaker Diarization</h3>

  <label class="toggle-label">
    <input type="checkbox" id="diarization-enabled">
    <span>Enable speaker identification</span>
  </label>

  <div id="diarization-settings" class="subsettings" style="display: none;">
    <div class="form-group">
      <label for="hf-token">Hugging Face Token</label>
      <div class="input-with-button">
        <input type="password" id="hf-token" placeholder="hf_xxxxxxxxxxxxx">
        <button id="test-token-btn" class="btn-secondary">Test</button>
      </div>
      <small>
        <a href="https://huggingface.co/settings/tokens" target="_blank">Get token</a> |
        <a href="https://huggingface.co/pyannote/speaker-diarization-community-1" target="_blank">Accept terms</a>
      </small>
    </div>

    <div class="form-group">
      <label>Speaker Detection</label>
      <label class="radio-label">
        <input type="radio" name="speaker-detection" value="auto" checked>
        Auto-detect (recommended)
      </label>
      <label class="radio-label">
        <input type="radio" name="speaker-detection" value="fixed">
        Fixed number: <input type="number" id="num-speakers" min="2" max="10" value="2" style="width: 60px">
      </label>
    </div>
  </div>
</div>
```

### Settings JavaScript

Add to `app.js`:

```javascript
// Load diarization settings
async function loadDiarizationSettings() {
  const settings = loadSettings();

  document.getElementById('diarization-enabled').checked = settings.diarizationEnabled || false;
  document.getElementById('num-speakers').value = settings.numSpeakers || 2;

  // Load token from secure storage
  const { token } = await window.electronAPI.getSecureToken('hf-token');
  if (token) {
    document.getElementById('hf-token').value = token;
  }

  toggleDiarizationSettings();
}

function toggleDiarizationSettings() {
  const enabled = document.getElementById('diarization-enabled').checked;
  document.getElementById('diarization-settings').style.display = enabled ? 'block' : 'none';
}

async function saveHfToken() {
  const token = document.getElementById('hf-token').value.trim();
  if (token) {
    await window.electronAPI.storeSecureToken('hf-token', token);
  } else {
    await window.electronAPI.deleteSecureToken('hf-token');
  }
}

async function testHfToken() {
  const token = document.getElementById('hf-token').value.trim();
  const btn = document.getElementById('test-token-btn');

  btn.textContent = 'Testing...';
  btn.disabled = true;

  const result = await window.electronAPI.testHfToken(token);

  if (result.valid) {
    btn.textContent = 'Valid!';
    btn.classList.add('btn-success');
  } else {
    btn.textContent = 'Invalid';
    btn.classList.add('btn-error');
    alert(`Token validation failed: ${result.error}`);
  }

  setTimeout(() => {
    btn.textContent = 'Test';
    btn.disabled = false;
    btn.classList.remove('btn-success', 'btn-error');
  }, 2000);
}

// Event listeners
document.getElementById('diarization-enabled').addEventListener('change', toggleDiarizationSettings);
document.getElementById('test-token-btn').addEventListener('click', testHfToken);
document.getElementById('hf-token').addEventListener('blur', saveHfToken);
```

### Transcription Flow Update

Modify the transcription completion handler in `app.js`:

```javascript
async function handleTranscriptionComplete(result) {
  const settings = loadSettings();

  // Check if diarization is enabled
  if (settings.diarizationEnabled) {
    const { token } = await window.electronAPI.getSecureToken('hf-token');

    if (token) {
      addLog('Adding speaker labels...');

      try {
        const diarizationResult = await window.electronAPI.diarizeTranscript({
          audioFile: result.audioPath,
          segments: result.segments,
          hfToken: token,
          numSpeakers: settings.speakerDetection === 'fixed' ? settings.numSpeakers : null
        });

        // Update result with speaker-labeled segments
        result.segments = diarizationResult.segments;
        result.numSpeakers = diarizationResult.num_speakers;

        addLog(`Identified ${diarizationResult.num_speakers} speakers`);
      } catch (error) {
        addLog(`Speaker detection failed: ${error.message}`, 'warning');
        // Continue without speaker labels (graceful degradation)
      }
    } else {
      addLog('Speaker detection enabled but no HF token configured', 'warning');
    }
  }

  // Continue with normal transcript display...
  displayTranscript(result);
}
```

---

## Enhanced Markdown Output

Update `_save_markdown()` in transcribers to include speaker labels:

```python
def _save_markdown(self, results: Dict[str, Any], audio_path: str, output_path: str):
    """Save transcription results to markdown with optional speaker labels."""
    lines = [
        f"# Meeting Transcription",
        f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M')}",
        f"**Duration:** {timedelta(seconds=int(results['duration']))}",
    ]

    # Add speaker count if available
    if results.get('numSpeakers'):
        lines.append(f"**Speakers:** {results['numSpeakers']}")

    lines.extend(["", "---", "", "## Transcript", ""])

    for segment in results['segments']:
        timestamp = f"[{self._format_time(segment['start'])} - {self._format_time(segment['end'])}]"

        if segment.get('speaker'):
            lines.append(f"{timestamp} **{segment['speaker']}:** {segment['text']}")
        else:
            lines.append(f"{timestamp} {segment['text']}")
        lines.append("")

    with open(output_path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
```

---

## Performance Considerations

| Metric | Transcription Only | With Diarization |
|--------|-------------------|------------------|
| 1-hour meeting (CPU) | ~30 seconds | ~90-120 seconds |
| 1-hour meeting (GPU) | ~10 seconds | ~30 seconds |
| Memory usage | ~1GB | ~3GB |
| First run | Fast | +30s model download |

### Accuracy by Speaker Count

- **2-3 speakers:** 90-95% accurate
- **4-6 speakers:** 80-90% accurate
- **7+ speakers:** 70-80% accurate

---

## Limitations & Trade-offs

### Pros
- Much easier to follow multi-person conversations
- Speaker time statistics
- Professional meeting notes
- Cross-platform (same code for Windows + macOS)

### Cons
- Requires Hugging Face account (free)
- Slower processing (2-3x)
- Works best with GPU
- May struggle with overlapping speech
- Similar voices can be confused

---

## Implementation Checklist

### Phase 1: Backend
- [ ] Create `backend/diarization/` module
- [ ] Implement `speaker_diarizer.py` with lazy loading
- [ ] Implement `diarize_transcript.py` CLI
- [ ] Add to `requirements-windows.txt` and `requirements-macos.txt`
- [ ] Test on both platforms

### Phase 2: Electron Bridge
- [ ] Add `safeStorage` IPC handlers for token
- [ ] Add `diarize-transcript` IPC handler
- [ ] Add `test-hf-token` IPC handler
- [ ] Update `preload.js` with new methods

### Phase 3: UI
- [ ] Add settings section in `index.html`
- [ ] Add settings logic in `app.js`
- [ ] Update transcription flow to call diarization
- [ ] Update markdown output format

### Phase 4: Testing
- [ ] Test with 2-speaker recording
- [ ] Test with 3+ speaker recording
- [ ] Test graceful fallback (no token, invalid token)
- [ ] Test on Windows with CUDA
- [ ] Test on macOS with MPS

---

## Future Enhancements (v2+)

- **Speaker naming:** Let users rename "Speaker 1" to "Alice"
- **Speaker profiles:** Save voice profiles for frequent participants
- **Real-time hints:** Show likely speaker during recording
- **Export options:** Color-coded speakers in PDF/DOCX

---

**Status:** Ready for implementation
**Priority:** Next feature after macOS stabilization
**Related:** [claude.md](../../claude.md) (architecture reference)

# Feature: Speaker Diarization (Who Spoke When)

## Overview

Add speaker identification to transcripts so users can see which person said what during meetings with multiple participants.

## Problem Being Solved

Current transcription output shows what was said, but not who said it:

```markdown
[00:00:00 - 00:00:05] Hello everyone, welcome to the meeting.
[00:00:05 - 00:00:10] Thanks for having me, excited to be here.
[00:00:10 - 00:00:15] Let's get started with the agenda.
```

This makes it hard to follow conversations with multiple speakers.

## Solution: Integrate pyannote.audio

Combine Whisper (transcription) with pyannote.audio (speaker diarization) to label speakers:

```markdown
[00:00:00 - 00:00:05] **Speaker 1:** Hello everyone, welcome to the meeting.
[00:00:05 - 00:00:10] **Speaker 2:** Thanks for having me, excited to be here.
[00:00:10 - 00:00:15] **Speaker 1:** Let's get started with the agenda.
```

### How It Works

1. **Record audio** (already working ✅)
2. **Run speaker diarization** → Get timestamps for each speaker
3. **Run Whisper transcription** → Get text with timestamps
4. **Merge results** → Match speaker labels to transcribed segments

## Technical Implementation

### Dependencies

```bash
pip install pyannote.audio
pip install torch  # Required by pyannote
```

**Note:** Requires Hugging Face token (free):
- Sign up at https://huggingface.co/
- Get token from https://huggingface.co/settings/tokens
- Accept model terms at https://huggingface.co/pyannote/speaker-diarization

### Backend Component: `speaker_diarizer.py`

```python
from pyannote.audio import Pipeline
import torch

class SpeakerDiarizer:
    def __init__(self, hf_token: str, device: str = "auto"):
        """Initialize speaker diarization pipeline."""
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"

        self.pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization",
            use_auth_token=hf_token
        )
        self.pipeline.to(torch.device(device))

    def diarize(self, audio_file: str, num_speakers: int = None):
        """
        Identify speakers in audio file.

        Args:
            audio_file: Path to WAV file
            num_speakers: Expected number of speakers (None = auto-detect)

        Returns:
            List of segments with speaker labels and timestamps
        """
        diarization = self.pipeline(audio_file, num_speakers=num_speakers)

        segments = []
        for turn, _, speaker in diarization.itertracks(yield_label=True):
            segments.append({
                'start': turn.start,
                'end': turn.end,
                'speaker': speaker
            })

        return segments
```

### Integration with Transcriber

Modify `transcriber.py` to merge speaker labels with transcription:

```python
def merge_transcription_with_speakers(transcription_segments, speaker_segments):
    """
    Merge Whisper transcription with speaker diarization.

    For each transcription segment, find the overlapping speaker
    and add speaker label to the output.
    """
    for trans_seg in transcription_segments:
        # Find speaker with most overlap
        best_speaker = find_overlapping_speaker(
            trans_seg['start'],
            trans_seg['end'],
            speaker_segments
        )
        trans_seg['speaker'] = best_speaker

    return transcription_segments
```

### Enhanced Markdown Output

```markdown
# Meeting Transcription
**Date:** 2025-11-19 10:30:00
**Duration:** 45:23
**Speakers:** 3

---

## Transcript

[00:00:00 - 00:00:05] **Speaker 1:** Hello everyone, welcome to the meeting.

[00:00:05 - 00:00:10] **Speaker 2:** Thanks for having me, excited to be here.

[00:00:10 - 00:00:15] **Speaker 1:** Let's get started with the agenda.

[00:00:15 - 00:00:25] **Speaker 3:** I have some updates on the project timeline.

---

## Speaker Summary

- **Speaker 1:** 15:30 (34.5%)
- **Speaker 2:** 18:45 (41.7%)
- **Speaker 3:** 10:48 (23.8%)
```

## User Experience

### Option 1: Automatic (Recommended)

```
Transcribing with speaker detection...
  ✓ Detected 3 speakers
  ✓ Transcription complete
  ✓ Speakers labeled

Transcript saved with speaker labels!
```

### Option 2: Manual Speaker Count

```
How many speakers are in this meeting?
  1. Auto-detect (recommended)
  2. Specify number

> 2

Enter number of speakers: 3

Transcribing with 3 speakers...
```

### Optional: Name Speakers

```
Would you like to name the speakers? (y/N): y

Speaker 1 name: Alice
Speaker 2 name: Bob
Speaker 3 name: Charlie

Output will use names instead of "Speaker 1", "Speaker 2", etc.
```

Enhanced output:

```markdown
[00:00:00 - 00:00:05] **Alice:** Hello everyone, welcome to the meeting.
[00:00:05 - 00:00:10] **Bob:** Thanks for having me, excited to be here.
```

## Performance Considerations

### Processing Time

- **Transcription only:** ~30 seconds for 1-hour meeting (CPU)
- **With diarization:** ~90 seconds for 1-hour meeting (CPU)
- **With GPU:** ~20 seconds for 1-hour meeting (both)

### Accuracy

- **2-3 speakers:** 90-95% accurate
- **4-6 speakers:** 80-90% accurate
- **7+ speakers:** 70-80% accurate (harder to distinguish)

### Resource Usage

- **CPU mode:** Works but slower (3-5x transcription time)
- **GPU mode:** Much faster, recommended for meetings > 30 minutes
- **Memory:** ~2GB RAM + model size (~1.5GB)

## Configuration

### `config.json`

```json
{
  "speaker_diarization": {
    "enabled": true,
    "auto_detect_speakers": true,
    "default_num_speakers": null,
    "min_speakers": 1,
    "max_speakers": 10,
    "hf_token": "hf_xxxxxxxxxxxxx"
  }
}
```

## UI Integration

### Settings Page

```
Speaker Diarization
  [x] Enable speaker identification

  Speaker Detection:
    ( ) Auto-detect number of speakers (recommended)
    (•) Fixed number: [3 ▼]

  Hugging Face Token: [hf_xxxxx...] [Test Token]

  [Save Settings]
```

### During Recording

```
Recording: 01:23 / 10:00
Speakers detected: 3
  Speaker 1: 00:45 (54%)
  Speaker 2: 00:30 (36%)
  Speaker 3: 00:08 (10%)
```

## Limitations & Trade-offs

### Pros:
- Much easier to follow multi-person conversations
- Speaker time statistics (who talked most)
- Professional meeting notes

### Cons:
- Requires Hugging Face account (free)
- Slower processing (2-3x)
- Works best with GPU
- May struggle with overlapping speech
- Needs distinct voices (similar voices = confusion)

## Alternative: Simple Two-Speaker Detection

For simpler use case (just mic vs desktop audio), we could do basic detection:
- Mic audio = "You"
- Desktop audio = "Other participant(s)"

This would be much simpler but less accurate for multi-person meetings.

## Priority & Timeline

**Priority:** Medium (nice-to-have, not essential)

**Estimated Effort:**
- Backend implementation: 1-2 days
- UI integration: 1 day
- Testing & polish: 1 day
- **Total:** ~3-4 days

**Dependencies:**
- ✅ Transcription working
- ⏳ Hugging Face integration
- ⏳ GPU support (optional but recommended)
- ⏳ Config file management

## Success Criteria

1. **Accurately identify 2-3 speakers** in test meetings (>90% accuracy)
2. **Processing time < 3x transcription-only** mode
3. **Clear speaker labels** in markdown output
4. **Optional speaker naming** in UI
5. **Graceful fallback** if diarization fails (show transcription without speakers)

## Future Enhancements

- **Speaker profiles:** Save voice profiles for frequent participants
- **Auto-naming:** "Detected John Smith (from voice profile)"
- **Real-time diarization:** Show speakers during recording (advanced)
- **Export options:** Color-coded speakers in PDF/DOCX

---

**Status:** Planned for future release
**Tracking:** Issue #TBD
**Related:** FEATURE_SETUP_WIZARD.md, transcriber.py

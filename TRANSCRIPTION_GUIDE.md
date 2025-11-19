# Transcription Guide

## Why Separate Tracks for Meetings?

When recording meetings, **mixing mic + desktop audio into one file creates poor transcription results**.

### The Problem with Mixed Audio:

1. **Multiple voices confuse Whisper** - Your voice + meeting participants = overlapping speech
2. **Lower audio quality** - Mixing/resampling degrades clarity
3. **Hard to distinguish speakers** - Whisper can't tell who said what
4. **Background noise** - Desktop audio adds noise to your voice

### Example:
```
Mixed audio transcription:
"Okay" (only 1 word from 10 seconds!)

Separate mic transcription:
"Okay, so today we're going to discuss the project timeline and deliverables..."
(full accurate transcript!)
```

## Recommended Approach: Separate Track Recording

### For Meetings (Zoom, Teams, etc.):

**Use `record_meeting.py`** - Records to two separate files:

1. **`meeting_mic_TIMESTAMP.wav`** - Your voice only
   - Clean audio
   - Perfect for transcription
   - Captures everything you say

2. **`meeting_desktop_TIMESTAMP.wav`** - Desktop audio only
   - Other participants' voices
   - Keep for reference/playback
   - Don't transcribe (too many voices)

### Workflow:

```bash
# 1. Record meeting with separate tracks
python record_meeting.py

# 2. Transcribe YOUR voice only
python test_transcribe.py
# Select: meeting_mic_TIMESTAMP.wav

# 3. You now have:
#    - Accurate transcript of what YOU said
#    - Desktop audio file for listening to others
```

## When to Use Mixed Audio:

Mixed audio (mic + desktop) is useful for:
- **Playback** - Hearing both sources together
- **Archiving** - Single file with full meeting audio
- **Video recording** - When you need synchronized audio

But **NOT for transcription** - always transcribe mic separately!

## Current Limitations:

- **Desktop audio transcription**: Not recommended due to multiple speakers
- **Speaker identification**: Not implemented (future feature)
- **Voice separation**: Not implemented (future feature)

## Future Enhancements:

1. **Dual transcription** - Transcribe mic and desktop separately, combine with labels
2. **Speaker diarization** - Identify "Speaker 1", "Speaker 2", etc.
3. **Voice isolation** - Use AI to separate your voice from background
4. **Real-time transcription** - Live captions during meeting

## GPU Acceleration Note:

**Python 3.13 users:** PyTorch doesn't support Python 3.13 yet.

**Solutions:**
- Use Python 3.12 or 3.11 for GPU support
- Or use CPU mode (4-5x slower but works fine for short meetings)

See [SETUP_GPU.md](SETUP_GPU.md) for details.

## Tips for Better Transcription:

1. **Good microphone** - Clear audio = better transcription
2. **Reduce background noise** - Quiet environment helps
3. **Speak clearly** - Whisper works best with clear speech
4. **Use correct language** - Select the right language in test_transcribe.py
5. **Mic-only mode** - Don't mix desktop audio for transcription

## Testing:

### Test 1: Mic-only recording (BEST for transcription)
```bash
python test_fix.py
python test_transcribe.py  # Select the file
```

### Test 2: Meeting recording (separate tracks)
```bash
python record_meeting.py
python test_transcribe.py  # Select meeting_mic_*.wav
```

### Test 3: Mixed audio (for playback, NOT transcription)
```bash
python test_mixing.py
# Play the file, but don't expect good transcription
```

## Summary:

✅ **DO:** Record mic separately for transcription
✅ **DO:** Use high-quality microphone
✅ **DO:** Speak clearly in quiet environment

❌ **DON'T:** Mix mic + desktop for transcription
❌ **DON'T:** Try to transcribe desktop audio with multiple speakers
❌ **DON'T:** Expect good results from low-quality/noisy audio

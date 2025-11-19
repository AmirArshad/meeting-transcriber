# Meeting Transcription Guide

## Understanding the Use Case

For a **meeting transcription tool**, you need to transcribe:
- ✅ **Your voice** (microphone)
- ✅ **Other participants' voices** (desktop audio from Zoom/Teams/etc)
- ✅ **Full conversation** for complete meeting notes

## Current Status & Challenges

### What's Working:
- ✅ Recording mic + desktop audio together
- ✅ Audio mixing at 48kHz (high quality)
- ✅ Whisper transcription (CPU/GPU)

### Current Challenge:
**Mixed audio with multiple speakers is harder to transcribe accurately**

When you have:
- Your voice (mic)
- Other people talking (desktop audio from meeting)
- People talking over each other
- Background noise

→ Whisper struggles more than with single-speaker audio

## Solutions to Improve Transcription Quality

### 1. Use a Larger Whisper Model

**Problem:** `base` model isn't good enough for noisy/multi-speaker audio

**Solution:** Use `small` or `medium` model

| Model  | Speed       | Quality | Best For |
|--------|-------------|---------|----------|
| tiny   | Very fast   | Poor    | Testing only |
| base   | Fast        | Good    | Single speaker, clean audio |
| small  | Medium      | Better  | **Meeting audio (RECOMMENDED)** |
| medium | Slow        | Best    | **Noisy meetings with overlap** |
| large  | Very slow   | Best    | Maximum accuracy |

**How to use:**
```bash
python test_meeting_transcription.py
# Select option 2 (small) or 3 (medium)
```

### 2. Improve Recording Quality

**Current Issues:**
- ~~Sample rate bug (recording at 16kHz instead of 48kHz)~~ - Being investigated
- Mixing algorithm may be too aggressive
- Volume normalization might be reducing clarity

**Recommendations:**
- ✅ Use good quality microphone
- ✅ Ensure desktop audio is clear (good speaker setup)
- ✅ Record in quiet environment
- ✅ Adjust volumes if one source is too quiet

### 3. Separate Track Recording (Alternative Approach)

If mixed transcription quality is still poor, record tracks separately:

**Option A: Dual Recording**
```python
# Record to two files
mic_file = "meeting_mic.wav"     # Your voice
desktop_file = "meeting_desktop.wav"  # Other participants

# Transcribe both separately
mic_transcript = transcribe(mic_file)
desktop_transcript = transcribe(desktop_file)

# Merge transcripts with timestamps
```

**Option B: Post-Meeting Processing**
```python
# Record mixed audio (for playback)
mixed_file = "meeting.wav"

# Extract tracks using audio separation (future feature)
your_voice = separate_voice(mixed_file, profile="your_voice")
others_voice = separate_voice(mixed_file, profile="others")

# Transcribe separately with speaker labels
```

### 4. Use Speaker Diarization (Future Feature)

Identify who said what:
```
[Speaker 1] Hello everyone, let's start the meeting
[Speaker 2] Great, I have the quarterly numbers ready
[Speaker 1] Perfect, please go ahead
```

**Not yet implemented** - coming in future version

## Testing Workflow

### Test 1: Quick Test (Current)
```bash
cd backend
python test_meeting_transcription.py
```

This will:
1. Record mic + desktop (10 seconds)
2. Transcribe with model of your choice
3. Show results and diagnostics

### Test 2: Real Meeting
```bash
# For a full meeting:
python test_recording.py
# Select mic ID: 39
# Select desktop ID: 43
# Duration: 1800 (30 minutes)

# Then transcribe:
python test_transcribe.py
# Select the file
# Choose model: small or medium
```

## Expected Results

### Good Scenario:
- Clear audio from both sources
- Minimal overlap (people take turns)
- Quiet environment
- Using `small` or `medium` model

→ Should get **70-90% accuracy**

### Challenging Scenario:
- Noisy background
- Multiple people talking over each other
- Poor audio quality
- Using `base` model

→ May get **30-50% accuracy** or worse

## Debugging Poor Transcription

If transcription is very poor:

1. **Check audio file**
   - Play it back - can YOU understand the words?
   - If you can't understand it clearly, neither can Whisper

2. **Check sample rate**
   - Should be 48000 Hz for mixed audio
   - If it's 16000 Hz, there's a bug

3. **Try larger model**
   - Switch from `base` → `small` → `medium`
   - Bigger models handle noise better

4. **Check volumes**
   - Is one source too quiet compared to the other?
   - Adjust `mic_volume` / `desktop_volume` in recorder

5. **Check for overlap**
   - Are multiple people talking at same time?
   - This is inherently hard for Whisper to handle

## Next Steps

1. **Test the new script:**
   ```bash
   python test_meeting_transcription.py
   ```

2. **Use larger model** - Try `small` or `medium` instead of `base`

3. **Report results** - Let us know what accuracy you get

4. **Future features:**
   - Real-time transcription
   - Speaker diarization
   - Voice separation
   - Better noise reduction

## GPU Acceleration (Important!)

For `medium` or `large` models, GPU is highly recommended:

**Without GPU:**
- 10-minute meeting → 50-100 minutes to transcribe

**With GPU:**
- 10-minute meeting → 10-20 minutes to transcribe

See [SETUP_GPU.md](SETUP_GPU.md) for setup (requires Python 3.12 or 3.11)

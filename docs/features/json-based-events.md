# JSON-Based Event System (Future Enhancement)

## Overview

Currently, the app uses string-based event detection to monitor recording status. This works but is fragile and should be refactored to a JSON-based event system for better reliability and maintainability.

## Current Implementation

### How It Works Now

The Python recorder scripts (both Windows and macOS) print status messages to stderr:

```python
print(f"Recording started!", file=sys.stderr)
print(f"Device configuration:", file=sys.stderr)
print(f"✓ Microphone stream opened at 48000 Hz", file=sys.stderr)
```

Electron's main process parses these strings to detect recording state:

```javascript
if (output.includes('Recording started!')) {
  recordingStarted = true;
}
```

### Current Status

- ✅ **Works on both platforms** (Windows and macOS)
- ✅ **Simple to implement** (just string matching)
- ✅ **Audio levels already use JSON** (good pattern to follow)

### Known Issues

1. **Fragile string matching**: Any typo breaks functionality
   - Example: We had a bug where macOS printed "Recording started..." (three dots) but Electron expected "Recording started!" (exclamation mark)

2. **Platform inconsistencies**: Different messages between Windows and macOS
   - Windows: `Device configuration:`, `Microphone stream opened`, `Desktop audio stream opened`
   - macOS: Only `Recording started!` (missing the intermediate progress updates)

3. **Hard to maintain**: Need to keep strings synchronized across 3+ files
   - `backend/audio/windows_recorder.py`
   - `backend/audio/macos_recorder.py`
   - `src/main.js`

4. **No structured data**: Can't include contextual information without complex parsing

5. **Localization impossible**: Can't translate messages without breaking detection

## Proposed Solution: JSON-Based Events

### Design

Use the same pattern we already have for audio levels, but extend it to all events.

**Current good pattern** (audio levels):
```python
levels = {
    "type": "levels",
    "mic": round(mic, 3),
    "desktop": round(desktop, 3)
}
print(json.dumps(levels), flush=True)
```

**Proposed event pattern**:
```python
# Recording started
print(json.dumps({
    "type": "event",
    "event": "recording_started",
    "timestamp": time.time()
}), flush=True)

# Device configuration
print(json.dumps({
    "type": "event",
    "event": "device_configured",
    "mic_rate": 48000,
    "desktop_rate": 48000,
    "channels": 2
}), flush=True)

# Stream opened
print(json.dumps({
    "type": "event",
    "event": "mic_stream_opened",
    "sample_rate": 48000,
    "channels": 1
}), flush=True)

# Desktop audio ready
print(json.dumps({
    "type": "event",
    "event": "desktop_stream_opened",
    "sample_rate": 48000,
    "channels": 2
}), flush=True)
```

### Benefits

1. **Type-safe**: Can validate event structure
2. **Extensible**: Add fields without breaking existing code
3. **Cross-platform**: Same format everywhere
4. **Localizable**: Human messages separate from event types
5. **Debuggable**: Can log full event objects
6. **Future-proof**: Easy to add new events
7. **Consistent**: All platforms send identical event structures

### Implementation Plan

#### Phase 1: Recorder Scripts

Update both `windows_recorder.py` and `macos_recorder.py`:

```python
import json
import time

def send_event(event_type, **data):
    """Send a JSON event to stdout for Electron to parse."""
    event = {
        "type": "event",
        "event": event_type,
        "timestamp": time.time(),
        **data
    }
    print(json.dumps(event), flush=True)

# Usage:
send_event("recording_started")
send_event("device_configured", mic_rate=48000, desktop_rate=48000)
send_event("mic_stream_opened", sample_rate=48000, channels=1)
send_event("desktop_stream_opened", sample_rate=48000, channels=2)
send_event("recording_stopped", duration=123.45)
```

#### Phase 2: Electron Parser

Update `src/main.js` to parse JSON events:

```javascript
pythonProcess.stdout.on('data', (data) => {
  const lines = data.toString().split('\n');

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);

      if (parsed.type === 'levels') {
        // Handle audio levels (already implemented)
        mainWindow.webContents.send('audio-levels', parsed);
        lastLevelUpdate = Date.now();
      }
      else if (parsed.type === 'event') {
        // Handle status events (NEW)
        handleRecordingEvent(parsed);
      }
    } catch (e) {
      // Not JSON, ignore
    }
  }
});

function handleRecordingEvent(event) {
  switch (event.event) {
    case 'recording_started':
      recordingStarted = true;
      recordingStartTime = Date.now();
      mainWindow.webContents.send('recording-init-progress', {
        stage: 'started',
        message: 'Recording started!'
      });
      resolve({ success: true, message: 'Recording started' });
      break;

    case 'device_configured':
      progressStage = 'device_config';
      mainWindow.webContents.send('recording-init-progress', {
        stage: 'device_config',
        message: `Configuring audio (${event.mic_rate} Hz)...`
      });
      break;

    case 'mic_stream_opened':
      progressStage = 'mic_opened';
      mainWindow.webContents.send('recording-init-progress', {
        stage: 'mic_opened',
        message: 'Microphone ready...'
      });
      break;

    case 'desktop_stream_opened':
      progressStage = 'desktop_opened';
      mainWindow.webContents.send('recording-init-progress', {
        stage: 'desktop_opened',
        message: 'Desktop audio ready...'
      });
      break;

    // Add more events as needed
  }
}
```

#### Phase 3: Backward Compatibility

During migration, support both methods:

```javascript
pythonProcess.stderr.on('data', (data) => {
  const output = data.toString();
  console.log(`[Recorder] ${output}`);

  // Keep old string-based detection as fallback
  if (!recordingStarted && output.includes('Recording started!')) {
    recordingStarted = true;
    // ...
  }
});
```

Remove old string matching after JSON events are confirmed working.

#### Phase 4: Keep stderr for Human Logs

stderr should remain for human-readable logs that users/developers see:

```python
# JSON events to stdout (for Electron)
send_event("recording_started")

# Human logs to stderr (for console/debugging)
print(f"✓ Recording started successfully", file=sys.stderr)
print(f"  Microphone: {mic_name}", file=sys.stderr)
print(f"  Desktop audio: {desktop_name}", file=sys.stderr)
```

### Standard Event Types

Define a standard set of events both platforms should support:

| Event | Description | Data Fields |
|-------|-------------|-------------|
| `recording_started` | Recording is active | `timestamp` |
| `recording_stopped` | Recording ended | `duration`, `timestamp` |
| `device_configured` | Audio devices configured | `mic_rate`, `desktop_rate`, `channels` |
| `mic_stream_opened` | Microphone stream active | `sample_rate`, `channels` |
| `desktop_stream_opened` | Desktop audio stream active | `sample_rate`, `channels` |
| `error` | Error occurred | `error_type`, `message`, `timestamp` |
| `warning` | Warning condition | `warning_type`, `message`, `timestamp` |
| `progress` | Processing progress | `stage`, `percent`, `message` |

### Testing Strategy

1. **Unit tests**: Parse sample JSON events in tests
2. **Integration tests**: Mock Python process and send JSON events
3. **Manual testing**: Test both Windows and macOS recorders
4. **Fallback verification**: Ensure old string method still works during migration

## Current Workarounds

Since this isn't implemented yet, current string matching issues can be avoided by:

1. **Be careful with punctuation**: "Recording started!" must match exactly
2. **Test both platforms**: Ensure messages are consistent between Windows and macOS
3. **Use constants**: Define message strings as constants to avoid typos
4. **Document dependencies**: Comment which strings Electron expects

## Priority

**Low priority** - Current system works, but should be refactored for long-term maintainability.

## Related Files

- `backend/audio/windows_recorder.py` - Windows recorder implementation
- `backend/audio/macos_recorder.py` - macOS recorder implementation
- `src/main.js` - Electron main process (event parser)
- `docs/features/json-based-events.md` - This document

## References

- Audio levels already use JSON (good pattern to follow)
- Python `json.dumps()` for serialization
- JavaScript `JSON.parse()` for deserialization
- Electron IPC for renderer communication

---

**Status:** Proposed (not implemented)

**Estimated Effort:** 4-6 hours
- 1-2 hours: Update both recorder scripts
- 1-2 hours: Update Electron parser
- 1-2 hours: Testing and bug fixes

**Risk Level:** Low (can implement with backward compatibility)

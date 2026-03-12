# JSON-Based Recorder Event System

## Overview

The app now uses a hybrid recorder event contract:

- structured JSON messages on `stdout` for `levels`, `event`, `warning`, and `error`
- human-readable compatibility/debug logs on `stderr`
- final recorder result JSON on `stdout`

The migration away from brittle string-based startup detection is partially complete, but not every recorder/progress path has been redesigned into a single final event schema yet.

## Current Implementation

### How It Works Now

The recorder scripts emit structured messages like:

```python
print(json.dumps({"type": "event", "event": "configuring_devices", "message": "Configuring audio devices..."}), flush=True)
print(json.dumps({"type": "event", "event": "mic_stream_opened", "message": "Microphone stream opened"}), flush=True)
print(json.dumps({"type": "event", "event": "recording_started", "message": "Recording started!"}), flush=True)
```

Electron's main process parses those JSON lines and maps them into renderer progress/warning updates.

Compatibility stderr logs still exist for human visibility and for any paths that have not yet been fully normalized.

### Current Status

- ✅ Structured `event`, `warning`, `error`, and `levels` messages are implemented in the active recorder contract
- ✅ `src/main.js` parses recorder `stdout` line-by-line via `parseRecorderStdoutChunk(...)`
- ✅ Startup state no longer depends on brittle stderr string matching for the main recording-start flow
- ⚠️ The contract is still hybrid: stderr remains part of debug/status output and some wording is preserved for compatibility/manual diagnosis
- ⚠️ Any change to recorder startup/progress behavior still requires coordinated updates across Electron, recorder scripts, and regression tests

### Current Electron Parser Shape

```javascript
const parsed = parseRecorderStdoutChunk(chunk, pendingBuffer)
// kinds: levels, event, warning, error, status, result, text
```

### Known Issues

1. **Hybrid contract remains**: stderr logs still exist beside structured stdout events, so both sides must stay aligned
2. **Event vocabulary is not final**: startup/progress/error naming is more consistent than before but not fully unified into one minimal schema
3. **Cross-file coordination required**: recorder output changes still affect `backend/audio/*_recorder.py`, `src/main.js`, `src/main-process-helpers.js`, and tests

## Direction

The direction is still to finish converging on structured JSON events for all recorder lifecycle messaging.

The current contract already uses this pattern for active recorder messaging:
```python
levels = {
    "type": "levels",
    "mic": round(mic, 3),
    "desktop": round(desktop, 3)
}
print(json.dumps(levels), flush=True)
```

Representative event pattern:
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

### Remaining Work

1. Finish converging the remaining recorder status/progress paths on structured stdout messages.
2. Keep stderr for human-readable logs only.
3. Keep the event vocabulary stable across Windows and macOS.
4. Preserve final-result JSON compatibility (`audioPath` on Windows, `outputPath` on macOS) unless all call sites are updated together.

### stderr Role

stderr should remain for human-readable logs that users/developers see:

```python
# JSON events to stdout (for Electron)
send_event("recording_started")

# Human logs to stderr (for console/debugging)
print(f"✓ Recording started successfully", file=sys.stderr)
print(f"  Microphone: {mic_name}", file=sys.stderr)
print(f"  Desktop audio: {desktop_name}", file=sys.stderr)
```

### Current Structured Event Types

The current recorder contract uses these structured message classes:

| Type | Purpose |
|------|---------|
| `levels` | Live audio meter updates |
| `event` | Recorder lifecycle/startup/state changes |
| `warning` | Structured non-fatal recorder issues |
| `error` | Structured fatal recorder issues |
| result JSON | Final recording output payload |

### Testing Strategy

1. **Unit tests**: Parse sample JSON events in tests
2. **Integration tests**: Mock Python process and send JSON events
3. **Manual testing**: Test both Windows and macOS recorders
4. **Fallback verification**: Ensure old string method still works during migration

## Validation Notes

If you change recorder output behavior, update all of:

- `backend/audio/windows_recorder.py`
- `backend/audio/macos_recorder.py`
- `src/main.js`
- `src/main-process-helpers.js`
- `tests/js/main-process-helpers.test.js`

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

**Status:** Partially implemented hybrid contract

**Risk Level:** Medium - recorder output changes are easy to regress unless Electron, both recorders, and tests are updated together

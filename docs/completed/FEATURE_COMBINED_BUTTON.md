# Feature: Combined Start/Stop/Transcribe Button

## Overview

Replace the separate "Start Recording" and "Stop Recording" buttons with a single action button that changes based on the current state.

## Problem Being Solved

**Current UX:**
- Two separate buttons: "Start Recording" and "Stop Recording"
- "Start" is enabled, "Stop" is disabled initially
- User must look for and click the correct button
- Takes up more UI space

**Issues:**
- Cognitive load - users must identify which button to press
- Visual clutter - two buttons for one action flow
- Not intuitive for first-time users

## Proposed Solution

### Single Button States

```
Idle State:
┌─────────────────────┐
│  ▶  Start Recording │  (Green button)
└─────────────────────┘

Recording State:
┌─────────────────────┐
│  ■  Stop & Transcribe│  (Red button)
└─────────────────────┘

Processing State:
┌─────────────────────┐
│  ⏳ Transcribing...  │  (Gray, disabled)
└─────────────────────┘

Ready State (after transcription):
┌─────────────────────┐
│  ▶  Start Recording │  (Green button, ready for next)
└─────────────────────┘
```

## User Experience

### Flow 1: Successful Recording
1. User clicks **"Start Recording"** (green)
2. Button changes to **"Stop & Transcribe"** (red)
3. Timer starts, status shows "Recording..."
4. User clicks **"Stop & Transcribe"**
5. Button changes to **"Transcribing..."** (gray, disabled)
6. Transcription completes
7. Button changes back to **"Start Recording"** (green)

### Flow 2: Error Handling
1. User clicks **"Start Recording"**
2. Error occurs (mic unavailable, etc.)
3. Button immediately returns to **"Start Recording"**
4. Error message shown in status area

## Visual Design

### Button States

| State | Label | Icon | Color | Enabled |
|-------|-------|------|-------|---------|
| Idle | "Start Recording" | ▶ | Green (#4CAF50) | Yes |
| Recording | "Stop & Transcribe" | ■ | Red (#F44336) | Yes |
| Stopping | "Stopping..." | ⏳ | Orange (#FF9800) | No |
| Transcribing | "Transcribing..." | ⏳ | Blue (#2196F3) | No |

### CSS Classes

```css
.record-button {
  padding: 12px 24px;
  font-size: 16px;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  transition: all 0.3s ease;
  min-width: 200px;
}

.record-button.idle {
  background-color: #4CAF50;
  color: white;
}

.record-button.idle:hover {
  background-color: #45a049;
  transform: scale(1.05);
}

.record-button.recording {
  background-color: #F44336;
  color: white;
  animation: pulse 2s infinite;
}

.record-button.recording:hover {
  background-color: #da190b;
}

.record-button.processing {
  background-color: #9E9E9E;
  color: white;
  cursor: not-allowed;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}
```

## Technical Implementation

### HTML Structure (Before)

```html
<div class="controls">
  <button id="startBtn" class="btn btn-primary">Start Recording</button>
  <button id="stopBtn" class="btn btn-secondary" disabled>Stop Recording</button>
</div>
```

### HTML Structure (After)

```html
<div class="controls">
  <button id="recordBtn" class="record-button idle">
    <span class="button-icon">▶</span>
    <span class="button-text">Start Recording</span>
  </button>
</div>
```

### JavaScript Changes

**Current Code:**
```javascript
// Two separate buttons
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');

startBtn.addEventListener('click', startRecording);
stopBtn.addEventListener('click', stopRecording);

function updateRecordingUI(recording) {
  startBtn.disabled = recording;
  stopBtn.disabled = !recording;
}
```

**New Code:**
```javascript
// Single button with state
const recordBtn = document.getElementById('recordBtn');
let recordingState = 'idle'; // idle, recording, processing

recordBtn.addEventListener('click', handleRecordButtonClick);

function handleRecordButtonClick() {
  if (recordingState === 'idle') {
    startRecording();
  } else if (recordingState === 'recording') {
    stopRecording();
  }
  // Do nothing if processing
}

function setRecordingState(state) {
  recordingState = state;
  updateButtonUI();
}

function updateButtonUI() {
  const button = recordBtn;
  const icon = button.querySelector('.button-icon');
  const text = button.querySelector('.button-text');

  // Remove all state classes
  button.className = 'record-button';

  switch (recordingState) {
    case 'idle':
      button.classList.add('idle');
      button.disabled = false;
      icon.textContent = '▶';
      text.textContent = 'Start Recording';
      break;

    case 'recording':
      button.classList.add('recording');
      button.disabled = false;
      icon.textContent = '■';
      text.textContent = 'Stop & Transcribe';
      break;

    case 'stopping':
      button.classList.add('processing');
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = 'Stopping...';
      break;

    case 'transcribing':
      button.classList.add('processing');
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = 'Transcribing...';
      break;
  }
}

async function startRecording() {
  try {
    setRecordingState('recording');
    startTimer();
    // ... rest of recording logic
  } catch (error) {
    setRecordingState('idle');
    // ... error handling
  }
}

async function stopRecording() {
  try {
    setRecordingState('stopping');
    stopTimer();

    const result = await window.electronAPI.stopRecording();

    setRecordingState('transcribing');
    await transcribeAudio();

    setRecordingState('idle');
  } catch (error) {
    setRecordingState('idle');
    // ... error handling
  }
}
```

## Accessibility

### Keyboard Navigation
- Button should be focusable with Tab key
- Space/Enter should trigger button action
- Screen reader should announce state changes

### ARIA Labels
```html
<button
  id="recordBtn"
  class="record-button idle"
  aria-label="Start recording audio"
  aria-live="polite">
  ...
</button>
```

**State changes:**
```javascript
function setRecordingState(state) {
  recordingState = state;

  // Update ARIA label
  switch (state) {
    case 'idle':
      recordBtn.setAttribute('aria-label', 'Start recording audio');
      break;
    case 'recording':
      recordBtn.setAttribute('aria-label', 'Stop recording and transcribe');
      break;
    case 'processing':
      recordBtn.setAttribute('aria-label', 'Processing, please wait');
      break;
  }

  updateButtonUI();
}
```

## Testing Checklist

- [ ] Button shows correct state after starting recording
- [ ] Button shows correct state after stopping recording
- [ ] Button disabled during transcription
- [ ] Button re-enables after transcription complete
- [ ] Button returns to idle state after error
- [ ] Keyboard navigation works (Tab, Space, Enter)
- [ ] Screen reader announces state changes
- [ ] Visual states are distinct and clear
- [ ] Animations don't cause performance issues
- [ ] Button is responsive on different screen sizes

## Benefits

### User Experience
- **Simpler:** One button instead of two
- **Intuitive:** Clear what to click at each stage
- **Visual feedback:** Color and icon changes show state
- **Less clutter:** Cleaner UI with more space for content

### Development
- **Easier maintenance:** Single button logic
- **Better state management:** Explicit state machine
- **Reduced bugs:** No sync issues between two buttons

## Alternative Designs Considered

### Option 1: Toggle Button (Rejected)
- Same button for start/stop without text change
- **Why rejected:** Users wouldn't know what clicking does mid-recording

### Option 2: Icon-Only Button (Rejected)
- Just icons (▶/■) without text
- **Why rejected:** Less clear for first-time users, accessibility concerns

### Option 3: Context Menu (Rejected)
- Right-click for options
- **Why rejected:** Hidden functionality, not discoverable

## Implementation Timeline

**Estimated Effort:** 2-3 hours

1. **HTML/CSS Changes** (30 min)
   - Update button markup
   - Add CSS classes for states
   - Test visual appearance

2. **JavaScript Refactoring** (1 hour)
   - Implement state machine
   - Update event handlers
   - Add ARIA labels

3. **Testing** (30 min)
   - Test all state transitions
   - Verify keyboard navigation
   - Check error handling

4. **Polish** (30 min)
   - Fine-tune animations
   - Adjust colors/spacing
   - Cross-browser testing

## Success Metrics

- **Reduced clicks:** 2 clicks per recording session (down from 2)
- **Clearer UX:** User testing shows improved clarity
- **Fewer errors:** Users don't click wrong button
- **Positive feedback:** "Much easier to use" comments

---

**Status:** Planned for v1.3.0
**Priority:** High
**Tracking:** Issue #TBD
**Related:** app.js, styles.css

# Feature: Real-Time Audio Visualizer

## Overview

Add visual feedback showing audio levels during recording to confirm microphone and desktop audio are being captured correctly.

## Problem Being Solved

**Current State:**
- No visual indication that audio is being captured
- Users unsure if microphone is working
- Can't tell if audio levels are too low/high
- Recording issues only discovered after stopping

**User Pain Points:**
- "Is my mic even recording?"
- "Did I select the right device?"
- "Is the volume too low?"
- "Why is there no sound in my recording?"

## Proposed Solution

### Design Option 1: Simple Level Meters (Recommended)

```
┌─────────────────────────────────────┐
│ Recording: 01:23                    │
│                                     │
│ 🎤 Microphone                       │
│ ████████████░░░░░░░░ 65%            │
│                                     │
│ 🔊 Desktop Audio                    │
│ ██████████████████░░ 95%            │
└─────────────────────────────────────┘
```

**Benefits:**
- Simple to implement
- Low CPU usage
- Clear indication of both audio sources
- Shows relative levels

### Design Option 2: Waveform Visualization

```
┌─────────────────────────────────────┐
│ Recording: 01:23                    │
│                                     │
│ 🎤 Microphone                       │
│ ▁▂▃▅▇▆▄▃▂▁▂▃▅▆▄▃▂▁▂▃▅▇▆▄▃         │
│                                     │
│ 🔊 Desktop Audio                    │
│ ▁▁▂▂▃▃▄▄▅▅▆▆▇▇▆▆▅▅▄▄▃▃▂▂▁▁         │
└─────────────────────────────────────┘
```

**Benefits:**
- More engaging visual feedback
- Shows audio patterns over time
- Professional appearance
- Helps identify audio issues (clipping, silence)

**Drawbacks:**
- Higher CPU usage
- More complex to implement
- May be distracting during recording

## Technical Implementation

### Option 1: Simple Level Meters

#### HTML Structure

```html
<div class="audio-visualizer" id="audioVisualizer" style="display: none;">
  <div class="visualizer-section">
    <div class="visualizer-label">
      <span class="icon">🎤</span>
      <span class="text">Microphone</span>
    </div>
    <div class="level-meter">
      <div class="level-bar" id="micLevelBar"></div>
      <span class="level-text" id="micLevelText">0%</span>
    </div>
  </div>

  <div class="visualizer-section">
    <div class="visualizer-label">
      <span class="icon">🔊</span>
      <span class="text">Desktop Audio</span>
    </div>
    <div class="level-meter">
      <div class="level-bar" id="desktopLevelBar"></div>
      <span class="level-text" id="desktopLevelText">0%</span>
    </div>
  </div>
</div>
```

#### CSS Styling

```css
.audio-visualizer {
  margin: 20px 0;
  padding: 15px;
  background: #f5f5f5;
  border-radius: 8px;
  border: 1px solid #ddd;
}

.visualizer-section {
  margin-bottom: 12px;
}

.visualizer-section:last-child {
  margin-bottom: 0;
}

.visualizer-label {
  display: flex;
  align-items: center;
  margin-bottom: 6px;
  font-size: 14px;
  color: #555;
}

.visualizer-label .icon {
  margin-right: 8px;
  font-size: 16px;
}

.level-meter {
  position: relative;
  width: 100%;
  height: 24px;
  background: #e0e0e0;
  border-radius: 4px;
  overflow: hidden;
}

.level-bar {
  height: 100%;
  width: 0%;
  background: linear-gradient(90deg, #4CAF50 0%, #8BC34A 50%, #FFC107 75%, #F44336 100%);
  transition: width 0.1s ease-out;
  border-radius: 4px;
}

.level-text {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  font-size: 12px;
  font-weight: bold;
  color: #333;
  text-shadow: 0 0 2px white;
}

/* Warning states */
.level-bar.low {
  background: #FFC107; /* Yellow for low volume */
}

.level-bar.clipping {
  background: #F44336; /* Red for clipping */
  animation: flash 0.5s infinite;
}

@keyframes flash {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
```

#### JavaScript Implementation

```javascript
let audioLevelInterval = null;

async function startAudioVisualization() {
  const visualizer = document.getElementById('audioVisualizer');
  visualizer.style.display = 'block';

  // Request audio levels from backend every 100ms
  audioLevelInterval = setInterval(async () => {
    try {
      const levels = await window.electronAPI.getAudioLevels();
      updateAudioLevels(levels);
    } catch (error) {
      console.error('Failed to get audio levels:', error);
    }
  }, 100);
}

function stopAudioVisualization() {
  if (audioLevelInterval) {
    clearInterval(audioLevelInterval);
    audioLevelInterval = null;
  }

  const visualizer = document.getElementById('audioVisualizer');
  visualizer.style.display = 'none';

  // Reset levels
  updateAudioLevels({ mic: 0, desktop: 0 });
}

function updateAudioLevels(levels) {
  // Update microphone level
  const micBar = document.getElementById('micLevelBar');
  const micText = document.getElementById('micLevelText');
  const micPercent = Math.round(levels.mic * 100);

  micBar.style.width = `${micPercent}%`;
  micText.textContent = `${micPercent}%`;

  // Apply warning classes
  micBar.classList.remove('low', 'clipping');
  if (micPercent < 20) {
    micBar.classList.add('low');
  } else if (micPercent > 95) {
    micBar.classList.add('clipping');
  }

  // Update desktop audio level
  const desktopBar = document.getElementById('desktopLevelBar');
  const desktopText = document.getElementById('desktopLevelText');
  const desktopPercent = Math.round(levels.desktop * 100);

  desktopBar.style.width = `${desktopPercent}%`;
  desktopText.textContent = `${desktopPercent}%`;

  desktopBar.classList.remove('low', 'clipping');
  if (desktopPercent < 20) {
    desktopBar.classList.add('low');
  } else if (desktopPercent > 95) {
    desktopBar.classList.add('clipping');
  }
}

// Integrate with recording flow
async function startRecording() {
  try {
    // ... existing start recording code ...

    startAudioVisualization(); // Add this
    startTimer();
  } catch (error) {
    // ... error handling ...
  }
}

async function stopRecording() {
  try {
    stopAudioVisualization(); // Add this
    stopTimer();

    // ... rest of stop recording code ...
  } catch (error) {
    // ... error handling ...
  }
}
```

#### Backend Changes (main.js)

```javascript
// Add IPC handler for audio levels
ipcMain.handle('get-audio-levels', async () => {
  if (!pythonProcess) {
    return { mic: 0, desktop: 0 };
  }

  // Send command to Python to get current audio levels
  // Python script would need to track RMS levels in real-time
  return new Promise((resolve) => {
    pythonProcess.stdin.write('get_levels\n');

    // Listen for response
    const handler = (data) => {
      try {
        const levels = JSON.parse(data.toString());
        pythonProcess.stdout.removeListener('data', handler);
        resolve(levels);
      } catch (e) {
        // Ignore parse errors
      }
    };

    pythonProcess.stdout.on('data', handler);

    // Timeout after 50ms
    setTimeout(() => {
      pythonProcess.stdout.removeListener('data', handler);
      resolve({ mic: 0, desktop: 0 });
    }, 50);
  });
});
```

#### Backend Changes (audio_recorder.py)

```python
def _mic_callback(self, in_data, frame_count, time_info, status):
    """Callback for microphone."""
    if self.is_recording:
        with self.lock:
            self.mic_frame_count += 1

            # Calculate RMS level for visualization
            audio_data = np.frombuffer(in_data, dtype=np.int16)
            rms = np.sqrt(np.mean(audio_data**2))
            self.mic_level = min(1.0, rms / 32768.0 * 10)  # Normalize to 0-1

            if self.mic_frame_count > self.preroll_frames:
                self.mic_frames.append(in_data)

    return (in_data, pyaudio.paContinue)

def _desktop_callback(self, in_data, frame_count, time_info, status):
    """Callback for desktop audio."""
    if self.is_recording:
        with self.lock:
            self.desktop_frame_count += 1

            # Calculate RMS level for visualization
            audio_data = np.frombuffer(in_data, dtype=np.int16)
            rms = np.sqrt(np.mean(audio_data**2))
            self.desktop_level = min(1.0, rms / 32768.0 * 10)

            if self.desktop_frame_count > self.preroll_frames:
                self.desktop_frames.append(in_data)

    return (in_data, pyaudio.paContinue)

def get_audio_levels(self):
    """Get current audio levels for visualization."""
    with self.lock:
        return {
            'mic': self.mic_level,
            'desktop': self.desktop_level
        }
```

### Option 2: Waveform Visualization

For waveform visualization, use Web Audio API:

```javascript
async function setupWaveformVisualization() {
  // Request microphone access for visualization
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();

  analyser.fftSize = 256;
  source.connect(analyser);

  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  const canvas = document.getElementById('waveformCanvas');
  const ctx = canvas.getContext('2d');

  function draw() {
    requestAnimationFrame(draw);

    analyser.getByteTimeDomainData(dataArray);

    ctx.fillStyle = 'rgb(240, 240, 240)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgb(76, 175, 80)';
    ctx.beginPath();

    const sliceWidth = canvas.width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = v * canvas.height / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    ctx.lineTo(canvas.width, canvas.height / 2);
    ctx.stroke();
  }

  draw();
}
```

## User Experience

### Visual Feedback States

1. **Silent** (0-20%)
   - Yellow bar
   - Warning: "Audio level very low"

2. **Normal** (20-80%)
   - Green gradient bar
   - No warning

3. **Loud** (80-95%)
   - Orange-yellow bar
   - Info: "Audio level high (good)"

4. **Clipping** (95-100%)
   - Red flashing bar
   - Warning: "Audio clipping! Lower volume"

## Performance Considerations

- **Update Rate:** 100ms (10 FPS) - good balance between responsiveness and CPU
- **CPU Usage:** ~0.5-1% additional (negligible)
- **Memory:** ~1-2 MB for buffers
- **Battery Impact:** Minimal on laptops

## Accessibility

- Provide text alternatives for visual levels
- Screen reader announces warnings ("Microphone volume low")
- High contrast mode support

## Testing Checklist

- [ ] Levels update in real-time during recording
- [ ] Mic and desktop levels are independent
- [ ] Warning states trigger correctly (low, clipping)
- [ ] Visualization stops when recording stops
- [ ] No performance impact on recording quality
- [ ] Works with different audio devices
- [ ] Responsive on different screen sizes

## Benefits

### For Users
- **Confidence:** Know audio is being captured
- **Quality Control:** Catch issues before finishing recording
- **Device Validation:** Confirm correct device selected
- **Volume Optimization:** Adjust mic/system volume in real-time

### For Support
- **Fewer Issues:** Users catch problems early
- **Better Diagnostics:** Screenshots show audio levels
- **Reduced Confusion:** Visual confirmation reduces support tickets

## Implementation Timeline

**Estimated Effort:** 4-6 hours

1. **Backend Audio Level Tracking** (2 hours)
   - Add RMS calculation to callbacks
   - Implement `get_levels` command
   - Test accuracy

2. **Frontend UI** (2 hours)
   - Create visualizer component
   - Add CSS styling
   - Implement level updates

3. **Integration** (1 hour)
   - Connect to recording flow
   - Add IPC handlers
   - Test end-to-end

4. **Polish** (1 hour)
   - Add warning states
   - Fine-tune animations
   - Cross-browser testing

## Success Metrics

- **User Confidence:** "I know my audio is working"
- **Fewer Bad Recordings:** Reduced reports of silent recordings
- **Better Quality:** Users adjust levels proactively
- **Positive Feedback:** "Love seeing the audio levels!"

## Future Enhancements

- **Frequency Spectrum:** Show frequency distribution
- **Peak Hold:** Show peak levels over time
- **Recording Quality Score:** Real-time quality estimation
- **Visual Alerts:** Flash screen on audio issues

---

**Status:** Planned for v1.3.0
**Priority:** Medium
**Tracking:** Issue #TBD
**Related:** app.js, audio_recorder.py, main.js

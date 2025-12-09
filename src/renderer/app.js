/**
 * Renderer process - UI logic for Meeting Transcriber (Redesigned)
 */

// UI Elements
const micSelect = document.getElementById('mic-select');
const desktopSelect = document.getElementById('desktop-select');
const languageSelect = document.getElementById('language-select');
const modelSelect = document.getElementById('model-select');
const refreshBtn = document.getElementById('refresh-devices');
const recordBtn = document.getElementById('record-btn');
const copyBtn = document.getElementById('copy-btn');
const saveBtn = document.getElementById('save-btn');
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const timer = document.getElementById('timer');
const progressLog = document.getElementById('progress-log');
const transcriptOutput = document.getElementById('transcript-output');
const transcriptActions = document.getElementById('transcript-actions');
const meetingList = document.getElementById('meeting-list');
const meetingDetails = document.getElementById('meeting-details');
const refreshHistory = document.getElementById('refresh-history');
const deleteMeeting = document.getElementById('delete-meeting');

// State
let recordingState = 'idle'; // idle, recording, stopping, transcribing, countdown
let countdownValue = 3;
let recordingStartTime = null;
let timerInterval = null;
let currentAudioFile = null;
let currentMeetingId = null;
let meetings = [];
let audioVisualizer = null;
let isFirstRecording = true; // Track if this is first recording (for longer timeout)
let isInitializing = true; // Track if app is still initializing

// Settings persistence
const SETTINGS_KEY = 'meeting-transcriber-settings';

// Load settings from localStorage
function loadSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    return saved ? JSON.parse(saved) : {};
  } catch (error) {
    console.error('Failed to load settings:', error);
    return {};
  }
}

// Save settings to localStorage
function saveSettings(settings) {
  try {
    const current = loadSettings();
    const updated = { ...current, ...settings };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
  } catch (error) {
    console.error('Failed to save settings:', error);
  }
}

// Apply saved settings to UI controls
function applySavedSettings() {
  const settings = loadSettings();

  if (settings.micId && micSelect.querySelector(`option[value="${settings.micId}"]`)) {
    micSelect.value = settings.micId;
  }

  if (settings.desktopId && desktopSelect.querySelector(`option[value="${settings.desktopId}"]`)) {
    desktopSelect.value = settings.desktopId;
  }

  if (settings.language) {
    languageSelect.value = settings.language;
  }

  if (settings.modelSize) {
    modelSelect.value = settings.modelSize;
  }
}

// Initialize app with first-time setup
// Initialize app with first-time setup
async function init() {
  const loadingScreen = document.getElementById('loading-screen');
  const loadingMessage = document.getElementById('loading-message');

  // Helper to update loading message
  const updateLoading = (message) => {
    if (loadingMessage) {
      loadingMessage.textContent = message;
    }
  };

  // Show initializing state
  setRecordingState('initializing');
  statusText.textContent = 'Initializing...';

  try {
    // Start audio warm-up in background immediately
    const warmUpPromise = window.electronAPI.warmUpAudioSystem()
      .catch(err => console.error('Audio warm-up failed:', err));

    // Step 1: Check if model is downloaded
    updateLoading('Checking system setup...');
    const settings = loadSettings();
    const modelSize = settings.modelSize || 'small';

    addLog('Checking system setup...');
    const modelCheck = await window.electronAPI.checkModelDownloaded(modelSize);

    if (!modelCheck.downloaded) {
      // Hide loading screen before showing first-time setup
      if (loadingScreen) {
        loadingScreen.classList.add('hidden');
        setTimeout(() => loadingScreen.remove(), 300);
      }

      // First-time setup: Download model
      await showFirstTimeSetup(modelSize);
    }

    // Hide loading screen immediately to show UI
    if (loadingScreen && !loadingScreen.classList.contains('hidden')) {
      updateLoading('Ready!');
      loadingScreen.classList.add('hidden');
      setTimeout(() => loadingScreen.remove(), 300);
    }

    // Step 2: Wait for audio system warm-up (while UI is visible)
    addLog('Initializing audio system...');
    statusText.textContent = 'Initializing audio...';
    
    await warmUpPromise;

    // Step 3: Load audio devices
    addLog('Loading audio devices...');
    await loadAudioDevices();

    // Step 4: Load meeting history
    await loadMeetingHistory();

    // Initialize visualizer
    audioVisualizer = new AudioVisualizer();

    setupEventListeners();

    // Mark initialization complete
    isInitializing = false;
    setRecordingState('idle');
    addLog('Ready to record!');
    statusText.textContent = 'Ready';
    console.log('App initialized');

  } catch (error) {
    console.error('Initialization error:', error);
    addLog(`Initialization error: ${error.message}`, 'error');
    isInitializing = false;
    setRecordingState('idle');

    // Hide loading screen on error
    if (loadingScreen) {
      loadingScreen.classList.add('hidden');
      setTimeout(() => loadingScreen.remove(), 300);
    }
  }
}

// First-time setup: Download model with progress UI
// First-time setup: Download model with progress UI
async function showFirstTimeSetup(modelSize) {
  addLog(`First-time setup: Downloading AI model (${modelSize})...`);

  const modal = document.getElementById('ftue-modal');
  const progressBar = document.getElementById('ftue-progress-bar');
  const progressText = document.getElementById('ftue-progress-text');
  const logOutput = document.getElementById('ftue-log-output');

  if (!modal) return;

  modal.classList.remove('hidden');
  progressText.textContent = 'Downloading Whisper AI model...';

  // Listen for progress updates
  window.electronAPI.onModelDownloadProgress((data) => {
    logOutput.textContent += data;
    logOutput.scrollTop = logOutput.scrollHeight;

    // Update progress text with meaningful messages
    if (data.includes('Loading')) {
      progressText.textContent = 'Loading model configuration...';
    } else if (data.includes('Downloading')) {
      progressText.textContent = 'Downloading model files (this may take a few minutes)...';
    } else if (data.includes('Model loaded') || data.includes('successfully')) {
      progressText.textContent = 'Model ready!';
    }
  });

  // Simulate progress (we don't get real download progress)
  let progress = 0;
  const progressInterval = setInterval(() => {
    if (progress < 90) {
      progress += Math.random() * 3;
      progressBar.style.width = `${Math.min(progress, 90)}%`;
    }
  }, 1000);

  try {
    // Download model
    await window.electronAPI.downloadModel(modelSize);

    // Complete
    clearInterval(progressInterval);
    progressBar.style.width = '100%';
    progressText.textContent = 'Setup complete!';

    addLog('AI model downloaded successfully!');

    // Wait a moment then remove overlay
    await new Promise(resolve => setTimeout(resolve, 1500));
    modal.classList.add('hidden');
  } catch (error) {
    clearInterval(progressInterval);
    progressText.textContent = 'Setup failed!';
    logOutput.textContent += `\nERROR: ${error.message}`;

    addLog('Model download failed. You can try again from Settings.', 'error');

    // Wait for user to see error, then continue anyway
    await new Promise(resolve => setTimeout(resolve, 3000));
    modal.classList.add('hidden');
  }
}

// Create setup overlay UI (similar to GPU installation)


// Load audio devices
async function loadAudioDevices() {
  try {
    addLog('Loading audio devices...');
    const devices = await window.electronAPI.getAudioDevices();

    // Check if no input devices found (likely permission issue on macOS)
    if (devices.inputs.length === 0) {
      const isMac = navigator.platform.includes('Mac');

      if (isMac) {
        addLog('⚠️ No microphone devices found - permission may not be granted', 'error');

        const shouldOpenSettings = confirm(
          'No microphone devices found!\n\n' +
          'This usually means microphone permission is not granted.\n\n' +
          'Would you like to open System Settings to grant permission?\n\n' +
          '1. Go to Privacy & Security → Microphone\n' +
          '2. Grant permission to Meeting Transcriber\n' +
          '3. Restart the app'
        );

        if (shouldOpenSettings) {
          window.electronAPI.openSystemSettings('microphone');
        }
      } else {
        addLog('⚠️ No microphone devices found', 'error');
      }
    }

    // Populate microphone dropdown
    micSelect.innerHTML = '<option value="">Select microphone...</option>';
    devices.inputs.forEach(device => {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = `${device.name} (${device.sample_rate} Hz)`;
      micSelect.appendChild(option);
    });

    // Populate desktop audio dropdown
    desktopSelect.innerHTML = '<option value="">Select desktop audio...</option>';
    devices.loopbacks.forEach(device => {
      const option = document.createElement('option');
      option.value = device.id;
      option.textContent = `${device.name} (${device.sample_rate} Hz)`;
      desktopSelect.appendChild(option);
    });

    addLog(`Found ${devices.inputs.length} microphones and ${devices.loopbacks.length} loopback devices`);

    // Apply saved settings after devices are loaded
    applySavedSettings();
  } catch (error) {
    console.error('Failed to load devices:', error);
    addLog(`Error: ${error.message}`, 'error');
  }
}

// Load meeting history
async function loadMeetingHistory() {
  try {
    // Scan the filesystem for any orphaned recordings not in the database
    try {
      const scanResult = await window.electronAPI.scanRecordings();
      if (scanResult.added > 0) {
        addLog(`Found ${scanResult.added} recording(s) not in database`);
      }
    } catch (scanError) {
      console.warn('Scan failed:', scanError);
    }

    // Load the meeting list
    meetings = await window.electronAPI.listMeetings();
    renderMeetingList();
  } catch (error) {
    console.error('Failed to load meeting history:', error);
    meetings = [];
    renderMeetingList();
  }
}

// Render meeting list
function renderMeetingList() {
  if (meetings.length === 0) {
    meetingList.innerHTML = '<p class="placeholder">No meetings recorded yet</p>';
    return;
  }

  meetingList.innerHTML = '';
  meetings.forEach((meeting, index) => {
    const item = document.createElement('div');
    item.className = 'meeting-item';
    item.dataset.id = meeting.id;

    item.innerHTML = `
      <div class="meeting-info">
        <div class="meeting-item-title">${meeting.title}</div>
        <div class="meeting-meta-row">
          <span class="meeting-item-date">${formatDate(meeting.date)}</span>
          <span class="meeting-item-duration">${meeting.duration}</span>
        </div>
      </div>
      <button class="delete-btn-list" title="Delete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    `;

    // Click on item to select
    item.addEventListener('click', (e) => {
      if (e.target.closest('.delete-btn-list')) return;
      selectMeeting(meeting.id);
    });

    // Delete button click
    const deleteBtn = item.querySelector('.delete-btn-list');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteMeetingHandler(meeting.id);
    });

    meetingList.appendChild(item);
  });
}

// Select meeting from history
function selectMeeting(meetingId) {
  const meeting = meetings.find(m => m.id === meetingId);
  if (!meeting) {
    console.error(`Meeting not found: ${meetingId}`);
    return;
  }

  // Update selection - convert both to strings for reliable comparison
  const targetId = String(meetingId);
  document.querySelectorAll('.meeting-item').forEach(item => {
    item.classList.toggle('selected', item.dataset.id === targetId);
  });

  currentMeetingId = meetingId;

  // Show meeting details
  document.getElementById('meeting-title').textContent = meeting.title;
  document.getElementById('meeting-date').textContent = formatDate(meeting.date);
  document.getElementById('meeting-duration').textContent = meeting.duration;

  // Load audio - Convert path to file:// URL for Electron
  const audioPlayer = document.getElementById('audio-player');
  const audioPath = meeting.audioPath.replace(/\\/g, '/');

  // Convert absolute path to file:// URL
  if (audioPath.match(/^[a-zA-Z]:/)) {
    // Windows path: D:/path -> file:///D:/path
    audioPlayer.src = 'file:///' + audioPath;
  } else if (audioPath.startsWith('/')) {
    // Unix path: /path -> file:///path
    audioPlayer.src = 'file://' + audioPath;
  } else {
    audioPlayer.src = audioPath;
  }

  audioPlayer.load();

  // Load transcript
  document.getElementById('meeting-transcript').textContent = meeting.transcript || 'No transcript available';

  // Show details panel, hide empty state
  document.getElementById('meeting-details-empty').style.display = 'none';
  meetingDetails.style.display = 'flex';
}

// Setup event listeners
function setupEventListeners() {
  refreshBtn.addEventListener('click', loadAudioDevices);
  refreshHistory.addEventListener('click', loadMeetingHistory);
  recordBtn.addEventListener('click', handleRecordButtonClick);
  copyBtn.addEventListener('click', copyTranscript);
  saveBtn.addEventListener('click', saveTranscript);
  if (deleteMeeting) {
    deleteMeeting.addEventListener('click', () => deleteMeetingHandler(currentMeetingId));
  }

  // Copy transcript from meeting details
  const copyTranscriptBtn = document.getElementById('copy-transcript-btn');
  if (copyTranscriptBtn) {
    copyTranscriptBtn.addEventListener('click', copyMeetingTranscript);
  }

  // Save settings when selections change
  micSelect.addEventListener('change', () => {
    saveSettings({ micId: micSelect.value });
  });

  desktopSelect.addEventListener('change', () => {
    saveSettings({ desktopId: desktopSelect.value });
  });

  languageSelect.addEventListener('change', () => {
    saveSettings({ language: languageSelect.value });
  });

  modelSelect.addEventListener('change', () => {
    saveSettings({ modelSize: modelSelect.value });
  });

  // Listen for progress updates
  window.electronAPI.onRecordingProgress((data) => {
    addLog(data);

    // Update status text during post-processing (stopping state)
    if (recordingState === 'stopping') {
      if (data.includes('Resampling')) {
        statusText.textContent = 'Processing: Resampling audio...';
      } else if (data.includes('noise reduction')) {
        statusText.textContent = 'Processing: Applying noise reduction...';
      } else if (data.includes('Mixing')) {
        statusText.textContent = 'Processing: Mixing audio tracks...';
      }
    }
  });

  window.electronAPI.onRecordingInitProgress((progress) => {
    // Show detailed progress during recording initialization
    addLog(progress.message);
    statusText.textContent = progress.message;
  });

  window.electronAPI.onTranscriptionProgress((data) => {
    addLog(data);
  });

  // Listen for audio levels
  window.electronAPI.onAudioLevels((levels) => {
    if (audioVisualizer && recordingState === 'recording') {
      audioVisualizer.updateLevels(levels);
    }
  });

  // FIX 3 & 4: Listen for recording warnings (heartbeat lost)
  window.electronAPI.onRecordingWarning((warning) => {
    console.error('Recording warning:', warning);
    addLog(`⚠️ ${warning.message}`, 'error');

    // Show visual indicator in UI
    statusText.textContent = 'Warning: Recording may be paused';
    statusIndicator.style.backgroundColor = '#f59e0b'; // Amber warning color
  });

  // Listen for updates
  window.electronAPI.onUpdateAvailable((updateInfo) => {
    showUpdateNotification(updateInfo);
  });

  // Check if user has recorded before (for timeout settings)
  const settings = loadSettings();
  if (settings.hasRecordedBefore) {
    isFirstRecording = false;
  }
}

// Handle record button click
function handleRecordButtonClick() {
  if (recordingState === 'idle') {
    startRecording();
  } else if (recordingState === 'recording') {
    stopRecording();
  }
  // Do nothing if processing or counting down
}

// Set recording state and update UI
function setRecordingState(state) {
  recordingState = state;
  updateButtonUI();
  updateControlsState();
}

// Update button appearance based on state
function updateButtonUI() {
  const button = recordBtn;
  const icon = button.querySelector('.button-icon');
  const text = button.querySelector('.button-text');

  // Remove all state classes
  button.className = 'record-button';

  switch (recordingState) {
    case 'initializing':
      button.classList.add('processing');
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = 'Initializing...';
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Initializing...';
      break;

    case 'idle':
      button.classList.add('idle');
      button.disabled = false;
      icon.textContent = '▶';
      text.textContent = 'Start Recording';
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Ready';
      break;

    case 'recording':
      button.classList.add('recording');
      button.disabled = false;
      icon.textContent = '■';
      text.textContent = 'Stop & Transcribe';
      statusIndicator.classList.add('recording');
      statusText.textContent = 'Recording...';
      break;

    case 'stopping':
      button.classList.add('processing');
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = 'Stopping...';
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Stopping...';
      break;

    case 'transcribing':
      button.classList.add('processing');
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = 'Transcribing...';
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Transcribing...';
      break;

    case 'countdown':
      button.classList.add('processing'); // Use processing style (grey)
      button.disabled = true;
      icon.textContent = '⏳';
      text.textContent = `Starting in ${countdownValue}...`;
      statusIndicator.classList.remove('recording');
      statusText.textContent = 'Preparing...';
      break;
  }
}

// Update other controls based on state
function updateControlsState() {
  const isBusy = recordingState !== 'idle' && recordingState !== 'initializing';

  micSelect.disabled = isBusy || isInitializing;
  desktopSelect.disabled = isBusy || isInitializing;
  languageSelect.disabled = isBusy || isInitializing;
  modelSelect.disabled = isBusy || isInitializing;
  refreshBtn.disabled = isBusy || isInitializing;
}

// Start recording with retry logic
async function startRecording() {
  const micId = micSelect.value;
  const desktopId = desktopSelect.value;

  if (!micId) {
    alert('Please select a microphone');
    return;
  }

  if (!desktopId) {
    alert('Please select a desktop audio source');
    return;
  }

  // Try up to 2 times with exponential backoff
  const maxAttempts = 2;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;

    try {
      if (attempt > 1) {
        addLog(`Retrying recording (attempt ${attempt}/${maxAttempts})...`);
        // Wait a moment before retrying
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        addLog('Starting recording...');
      }

      // Start countdown IMMEDIATELY (don't wait for backend)
      setRecordingState('countdown');

      // Start backend initialization in parallel with countdown
      const recordingPromise = window.electronAPI.startRecording({
        micId: parseInt(micId),
        loopbackId: parseInt(desktopId),
        isFirstRecording: isFirstRecording && attempt === 1 // Only use first-recording timeout on first attempt
      });

      // Countdown runs in parallel (3 seconds)
      const countdownPromise = startCountdown();

      // Wait for both to complete
      // In most cases, countdown will finish first and backend will be ready by then
      await Promise.all([recordingPromise, countdownPromise]);

      // After first successful recording, set flag to false
      if (isFirstRecording) {
        isFirstRecording = false;
        saveSettings({ hasRecordedBefore: true });
      }

      setRecordingState('recording');
      recordingStartTime = Date.now();

      // Update UI
      startTimer();
      audioVisualizer.start();

      // Clear previous transcript
      transcriptOutput.innerHTML = '<p class="placeholder">Recording in progress...</p>';
      transcriptActions.style.display = 'none';

      addLog('Recording started!');
      return; // Success! Exit the retry loop

    } catch (error) {
      console.error(`Failed to start recording (attempt ${attempt}):`, error);

      if (attempt >= maxAttempts) {
        // All attempts failed
        const errorMsg = error.message || 'Unknown error';
        addLog(`Recording failed after ${maxAttempts} attempts: ${errorMsg}`, 'error');

        // Show helpful error dialog
        const shouldCheckPermissions = errorMsg.toLowerCase().includes('permission') ||
                                        errorMsg.toLowerCase().includes('access') ||
                                        errorMsg.toLowerCase().includes('device');

        if (shouldCheckPermissions) {
          // Platform-specific permission instructions
          const isMac = navigator.platform.includes('Mac');

          if (isMac) {
            const shouldOpenSettings = confirm(
              'Recording failed. Permission might be missing.\n\n' +
              'Would you like to open System Settings to check permissions?\n\n' +
              'Check both Microphone and Screen Recording permissions.'
            );

            if (shouldOpenSettings) {
              // Open Screen Recording by default as it's the more common "silent fail"
              window.electronAPI.openSystemSettings('screen');
            }
          } else {
            alert(
              'Recording failed. Please check:\n\n' +
              '1. Microphone permissions are granted to this app\n' +
              '2. Selected devices are not in use by another application\n' +
              '3. Devices are properly connected\n\n' +
              '• Grant microphone permissions in Windows Settings\n' +
              '• Restart the application\n' +
              '• Try different audio devices'
            );
          }
        } else {
          alert(
            `Recording failed: ${errorMsg}\n\n` +
            'Try refreshing your audio devices or restarting the app.'
          );
        }

        setRecordingState('idle');
        return; // Give up
      } else {
        // Try again
        addLog(`Attempt ${attempt} failed. Retrying...`, 'warning');
      }
    }
  }
}

// Countdown function
function startCountdown() {
  return new Promise((resolve) => {
    countdownValue = 3;
    updateButtonUI(); // Show initial "Starting in 3..."
    
    const interval = setInterval(() => {
      countdownValue--;
      
      if (countdownValue > 0) {
        updateButtonUI();
      } else {
        clearInterval(interval);
        resolve();
      }
    }, 1000);
  });
}

// Stop recording and auto-transcribe
async function stopRecording() {
  try {
    addLog('Stopping recording...');

    // Immediately update UI to show we're stopping
    setRecordingState('stopping');
    stopTimer(); // Stop timer immediately
    audioVisualizer.stop();

    const result = await window.electronAPI.stopRecording();

    // Store the audio file path for transcription
    if (result.audioPath) {
      currentAudioFile = result.audioPath;
      addLog(`Recording saved: ${currentAudioFile}`);

      // Auto-transcribe
      addLog('Starting transcription...');
      await transcribeAudio();
    } else {
      addLog('Warning: Recording stopped but no audio file path returned', 'warning');
      transcriptOutput.innerHTML = '<p class="placeholder error">Recording completed but file not found. The recording may have failed.</p>';
      setRecordingState('idle');
    }

  } catch (error) {
    console.error('Failed to stop recording:', error);
    addLog(`Error: ${error.message}`, 'error');
    transcriptOutput.innerHTML = `<p class="placeholder error">Recording failed: ${error.message}</p>`;
    
    stopTimer();
    audioVisualizer.stop();
    setRecordingState('idle');
  }
}

// Helper function to format seconds into MM:SS
function formatTimestamp(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Transcribe audio (auto-called after stop)
async function transcribeAudio() {
  const language = languageSelect.value;
  const modelSize = modelSelect.value;

  // Validate we have an audio file
  if (!currentAudioFile) {
    addLog('Error: No audio file to transcribe', 'error');
    transcriptOutput.innerHTML = '<p class="placeholder error">No audio file available for transcription.</p>';
    setRecordingState('idle');
    return;
  }

  try {
    setRecordingState('transcribing');
    transcriptOutput.innerHTML = '<p class="placeholder">Transcribing... This may take a moment.</p>';

    addLog(`Language: ${language}, Model: ${modelSize}`);
    addLog(`File: ${currentAudioFile}`);

    const result = await window.electronAPI.transcribeAudio({
      audioFile: currentAudioFile,
      language,
      modelSize
    });

    // Display transcript with timestamps
    transcriptOutput.innerHTML = '';

    if (result.segments && result.segments.length > 0) {
      // Display each segment with timestamp
      result.segments.forEach(segment => {
        const segmentDiv = document.createElement('div');
        segmentDiv.style.marginBottom = '12px';

        // Timestamp
        const timestamp = document.createElement('div');
        timestamp.style.fontSize = '11px';
        timestamp.style.color = '#888';
        timestamp.style.marginBottom = '4px';
        const startTime = formatTimestamp(segment.start);
        const endTime = formatTimestamp(segment.end);
        timestamp.textContent = `[${startTime} - ${endTime}]`;

        // Text
        const text = document.createElement('div');
        text.textContent = segment.text;
        text.style.lineHeight = '1.5';

        segmentDiv.appendChild(timestamp);
        segmentDiv.appendChild(text);
        transcriptOutput.appendChild(segmentDiv);
      });
    } else {
      // Fallback to plain text if no segments
      const transcriptText = document.createElement('div');
      transcriptText.textContent = result.text || 'No transcription available';
      transcriptOutput.appendChild(transcriptText);
    }

    // Enable actions
    transcriptActions.style.display = 'flex';

    addLog('Transcription complete!');
    addLog(`Word count: ${result.text.split(' ').length}`);

    // Save meeting to history
    try {
      addLog('Saving meeting to history...');
      await window.electronAPI.addMeeting({
        audioPath: result.audioPath || currentAudioFile,
        transcriptPath: result.output_file,
        duration: result.duration || 0,
        language: language,
        model: modelSize
      });
      addLog('Meeting saved!');
    } catch (saveError) {
      console.error('Failed to save meeting:', saveError);
      addLog(`Warning: Could not save to history: ${saveError.message}`, 'warning');
    }

    // Reload meeting history
    await loadMeetingHistory();
    
    setRecordingState('idle');

  } catch (error) {
    console.error('Failed to transcribe:', error);
    addLog(`Error: ${error.message}`, 'error');
    transcriptOutput.innerHTML = `<p class="placeholder error">Transcription failed: ${error.message}</p>`;
    setRecordingState('idle');
  }
}

// Copy transcript to clipboard (current recording)
function copyTranscript() {
  const text = transcriptOutput.textContent;
  navigator.clipboard.writeText(text);
  addLog('Transcript copied to clipboard!');
}

// Copy meeting transcript to clipboard
function copyMeetingTranscript() {
  const transcriptEl = document.getElementById('meeting-transcript');
  const text = transcriptEl.textContent;

  navigator.clipboard.writeText(text).then(() => {
    // Visual feedback
    const btn = document.getElementById('copy-transcript-btn');
    const originalHTML = btn.innerHTML;
    btn.innerHTML = '<span class="btn-icon">✓</span> Copied!';
    btn.disabled = true;

    setTimeout(() => {
      btn.innerHTML = originalHTML;
      btn.disabled = false;
    }, 2000);
  }).catch(err => {
    console.error('Failed to copy:', err);
    alert('Failed to copy transcript to clipboard');
  });
}

// Save transcript
function saveTranscript() {
  // TODO: Implement file save dialog via IPC
  addLog('Save feature coming soon!');
}

// Delete meeting
async function deleteMeetingHandler(meetingId) {
  const idToDelete = meetingId || currentMeetingId;
  if (!idToDelete) {
    console.error('No meeting ID to delete');
    return;
  }

  const meeting = meetings.find(m => m.id === idToDelete);
  if (!meeting) {
    console.error('Meeting not found:', idToDelete);
    return;
  }

  if (confirm(`Are you sure you want to delete "${meeting.title}"?`)) {
    try {
      // Release audio player file lock before deleting (Windows issue)
      const audioPlayer = document.getElementById('audio-player');
      if (audioPlayer.src) {
        audioPlayer.pause();
        audioPlayer.removeAttribute('src');
        audioPlayer.load();
      }

      addLog(`Deleting meeting: ${meeting.title}...`);

      // Small delay to ensure OS releases the file handle
      await new Promise(resolve => setTimeout(resolve, 300));

      await window.electronAPI.deleteMeeting(idToDelete);

      // Clear the view immediately
      if (currentMeetingId === idToDelete) {
        meetingDetails.style.display = 'none';
        document.getElementById('meeting-details-empty').style.display = 'flex';
        currentMeetingId = null;
      }

      // Remove from local list immediately
      meetings = meetings.filter(m => m.id !== idToDelete);
      renderMeetingList();

      addLog('Meeting deleted successfully!');
    } catch (error) {
      console.error('Delete failed:', error);
      addLog(`Error: ${error.message}`, 'error');
      alert('Failed to delete meeting: ' + error.message);
    }
  }
}

// Timer functions
function startTimer() {
  timerInterval = setInterval(() => {
    const elapsed = Date.now() - recordingStartTime;
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    timer.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// Add log message
function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = document.createElement('div');
  logEntry.className = `log-entry ${type}`;
  logEntry.textContent = `[${timestamp}] ${message}`;
  progressLog.appendChild(logEntry);
  progressLog.scrollTop = progressLog.scrollHeight;
}

// Format date helper
function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Tab switching
function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');

  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const targetTab = button.dataset.tab;

      // Update active button
      tabButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');

      // Update active pane
      tabPanes.forEach(pane => {
        if (pane.id === `${targetTab}-tab`) {
          pane.classList.add('active');
        } else {
          pane.classList.remove('active');
        }
      });
    });
  });
}

// ============================================================================
// Settings Tab - GPU Acceleration
// ============================================================================

async function initSettingsTab() {
  // Get system info
  try {
    const systemInfo = await window.electronAPI.getSystemInfo();
    document.getElementById('app-version').textContent = systemInfo.app;
    document.getElementById('electron-version').textContent = systemInfo.electron;
    document.getElementById('python-version').textContent = systemInfo.python;
  } catch (error) {
    console.error('Failed to get system info:', error);
  }

  // Check GPU status
  await checkGPUStatus();

  // Set up event listeners
  document.getElementById('install-gpu-btn').addEventListener('click', installGPUAcceleration);
  document.getElementById('uninstall-gpu-btn').addEventListener('click', uninstallGPUAcceleration);

  // Listen for installation progress
  window.electronAPI.onGPUInstallProgress((data) => {
    appendGPULog(data);
  });
}

async function checkGPUStatus() {
  const statusBadge = document.getElementById('gpu-status-badge');
  const gpuDescription = document.getElementById('gpu-description');
  const gpuLabel1 = document.getElementById('gpu-label-1');
  const gpuValue1 = document.getElementById('gpu-value-1');
  const gpuLabel2 = document.getElementById('gpu-label-2');
  const gpuValue2 = document.getElementById('gpu-value-2');
  const gpuLabel3 = document.getElementById('gpu-label-3');
  const gpuValue3 = document.getElementById('gpu-value-3');
  const gpuRow3 = document.getElementById('gpu-row-3');
  const installBtn = document.getElementById('install-gpu-btn');
  const uninstallBtn = document.getElementById('uninstall-gpu-btn');
  const gpuActions = document.getElementById('gpu-actions');

  statusBadge.textContent = 'Checking...';
  statusBadge.className = 'setting-badge';

  try {
    // Get platform info
    const platform = await window.electronAPI.getPlatform();
    const isMac = platform === 'darwin';

    if (isMac) {
      // ============ macOS: Show Metal/MLX Status ============
      gpuDescription.textContent = 'GPU acceleration using Apple\'s Metal framework for Apple Silicon Macs. Provides 3-5x faster transcription.';
      
      // Check if Apple Silicon
      const arch = await window.electronAPI.getArch();
      const isAppleSilicon = arch === 'arm64';

      if (isAppleSilicon) {
        // Apple Silicon - Metal always available
        gpuLabel1.textContent = 'GPU:';
        gpuValue1.textContent = 'Apple Silicon (Metal GPU)';
        gpuValue1.className = 'info-value success';

        gpuLabel2.textContent = 'Framework:';
        gpuValue2.textContent = 'MLX (Metal acceleration)';
        gpuValue2.className = 'info-value success';

        gpuLabel3.textContent = 'Status:';
        gpuValue3.textContent = 'Enabled by default';
        gpuValue3.className = 'info-value success';

        statusBadge.textContent = 'Enabled (Metal)';
        statusBadge.classList.add('enabled');
      } else {
        // Intel Mac - CPU only
        gpuLabel1.textContent = 'Chip:';
        gpuValue1.textContent = 'Intel (x64)';
        gpuValue1.className = 'info-value';

        gpuLabel2.textContent = 'Acceleration:';
        gpuValue2.textContent = 'CPU only (no Metal GPU)';
        gpuValue2.className = 'info-value warning';

        gpuLabel3.textContent = 'Framework:';
        gpuValue3.textContent = 'faster-whisper (CPU)';
        gpuValue3.className = 'info-value';

        statusBadge.textContent = 'CPU Fallback';
        statusBadge.classList.add('disabled');
      }

      // Hide install/uninstall buttons on macOS (MLX is bundled)
      gpuActions.style.display = 'none';

    } else {
      // ============ Windows: Show CUDA Status ============
      gpuDescription.textContent = 'Enable GPU acceleration for 4-5x faster transcription. Requires NVIDIA GPU with CUDA support.';
      
      // Update labels for Windows
      gpuLabel1.textContent = 'GPU Detected:';
      gpuLabel2.textContent = 'CUDA Libraries:';
      gpuLabel3.textContent = 'Download Size:';

      // Check if GPU exists
      const gpuInfo = await window.electronAPI.checkGPU();

      if (gpuInfo.hasGPU) {
        gpuValue1.textContent = gpuInfo.gpuName;
        gpuValue1.classList.add('success');
      } else {
        gpuValue1.textContent = 'No NVIDIA GPU detected';
        gpuValue1.classList.add('error');
        gpuValue2.textContent = 'N/A';
        gpuValue3.textContent = 'N/A';
        statusBadge.textContent = 'Not Available';
        statusBadge.classList.add('disabled');
        installBtn.disabled = true;
        return;
      }

      // Check CUDA installation
      const cudaInfo = await window.electronAPI.checkCUDA();

      if (cudaInfo.installed) {
        gpuValue2.textContent = `Installed (CUDA ${cudaInfo.version})`;
        gpuValue2.classList.add('success');
        gpuValue3.textContent = 'Already installed';
        statusBadge.textContent = 'Enabled';
        statusBadge.classList.add('enabled');
        installBtn.style.display = 'none';
        uninstallBtn.style.display = 'block';
      } else {
        gpuValue2.textContent = 'Not installed';
        gpuValue2.classList.add('warning');
        gpuValue3.textContent = '~2-3 GB';
        statusBadge.textContent = 'Available';
        statusBadge.classList.add('disabled');
        installBtn.disabled = false;
        installBtn.style.display = 'block';
        uninstallBtn.style.display = 'none';
      }

      gpuActions.style.display = 'block';
    }
  } catch (error) {
    console.error('Failed to check GPU status:', error);
    statusBadge.textContent = 'Error';
    statusBadge.classList.add('disabled');
    gpuDescription.textContent = 'Failed to detect system configuration.';
  }
}

async function installGPUAcceleration() {
  const installBtn = document.getElementById('install-gpu-btn');
  const statusBadge = document.getElementById('gpu-status-badge');
  const progressDiv = document.getElementById('gpu-progress');
  const progressBar = document.getElementById('gpu-progress-bar');
  const progressText = document.getElementById('gpu-progress-text');
  const logDiv = document.getElementById('gpu-log');
  const logOutput = document.getElementById('gpu-log-output');

  // Show confirmation
  const confirmed = confirm(
    'This will download and install ~2-3GB of GPU acceleration libraries.\n\n' +
    'The download may take 10-30 minutes depending on your internet speed.\n\n' +
    'Continue?'
  );

  if (!confirmed) return;

  // UI setup
  installBtn.disabled = true;
  statusBadge.textContent = 'Installing...';
  statusBadge.className = 'setting-badge installing';
  progressDiv.style.display = 'block';
  logDiv.style.display = 'block';
  logOutput.textContent = '';
  progressBar.style.width = '0%';
  progressText.textContent = 'Starting installation...';

  try {
    // Simulate progress (pip doesn't give us real progress)
    let progress = 0;
    const progressInterval = setInterval(() => {
      if (progress < 90) {
        progress += Math.random() * 5;
        progressBar.style.width = `${Math.min(progress, 90)}%`;
      }
    }, 2000);

    progressText.textContent = 'Downloading PyTorch with CUDA support...';

    // Install GPU packages
    await window.electronAPI.installGPU();

    // Complete progress
    clearInterval(progressInterval);
    progressBar.style.width = '100%';
    progressText.textContent = 'Installation complete!';

    // Update status
    statusBadge.textContent = 'Enabled';
    statusBadge.className = 'setting-badge enabled';

    // Hide progress after delay
    setTimeout(() => {
      progressDiv.style.display = 'none';
      logDiv.style.display = 'none';
    }, 3000);

    // Refresh status
    await checkGPUStatus();

    alert('GPU acceleration installed successfully!\n\nFaster transcription is now available.');
  } catch (error) {
    console.error('GPU installation failed:', error);
    appendGPULog(`\nERROR: ${error.message}`);
    progressText.textContent = 'Installation failed!';
    statusBadge.textContent = 'Failed';
    statusBadge.className = 'setting-badge disabled';
    installBtn.disabled = false;

    alert('GPU installation failed. Check the log for details.');
  }
}

async function uninstallGPUAcceleration() {
  const confirmed = confirm(
    'This will remove all GPU acceleration libraries.\n\n' +
    'Transcription will fall back to CPU mode.\n\n' +
    'Continue?'
  );

  if (!confirmed) return;

  const statusBadge = document.getElementById('gpu-status-badge');
  statusBadge.textContent = 'Uninstalling...';
  statusBadge.className = 'setting-badge';

  try {
    await window.electronAPI.uninstallGPU();
    await checkGPUStatus();
    alert('GPU acceleration uninstalled successfully.');
  } catch (error) {
    console.error('Uninstall failed:', error);
    alert('Failed to uninstall GPU acceleration.');
  }
}

function appendGPULog(text) {
  const logOutput = document.getElementById('gpu-log-output');
  logOutput.textContent += text;
  logOutput.scrollTop = logOutput.scrollHeight;
}

// ============================================================================
// Update Notification
// ============================================================================

let currentUpdateInfo = null;

function showUpdateNotification(updateInfo) {
  currentUpdateInfo = updateInfo;

  const banner = document.getElementById('update-banner');
  const title = document.getElementById('update-title');
  const description = document.getElementById('update-description');
  const downloadBtn = document.getElementById('download-update');
  const dismissBtn = document.getElementById('dismiss-update');

  // Update content
  title.textContent = `Update Available: v${updateInfo.version}`;
  description.textContent = `A new version of Meeting Transcriber is ready to download.`;

  // Show banner
  banner.style.display = 'block';

  // Set up button handlers
  downloadBtn.onclick = handleDownloadUpdate;
  dismissBtn.onclick = handleDismissUpdate;

  addLog(`✨ Update available: v${updateInfo.version}`);
}

async function handleDownloadUpdate() {
  if (!currentUpdateInfo) return;

  try {
    addLog('Opening download page...');
    await window.electronAPI.downloadUpdate(currentUpdateInfo.downloadUrl);
    addLog('Download started in your browser. Install when ready!');

    // Keep banner visible so user remembers to install
  } catch (error) {
    console.error('Failed to open download:', error);
    addLog('Failed to open download page', 'error');
  }
}

function handleDismissUpdate() {
  const banner = document.getElementById('update-banner');
  banner.style.display = 'none';
  addLog('Update reminder dismissed');
}

// ============================================================================
// Audio Visualizer Class
// ============================================================================

class AudioVisualizer {
  constructor() {
    this.container = document.getElementById('audio-visualizer');
    this.micCanvas = document.getElementById('mic-waveform');
    this.desktopCanvas = document.getElementById('desktop-waveform');

    this.micCtx = this.micCanvas.getContext('2d');
    this.desktopCtx = this.desktopCanvas.getContext('2d');

    // History buffers for waveform effect
    this.bufferSize = 50;
    this.micBuffer = new Array(this.bufferSize).fill(0);
    this.desktopBuffer = new Array(this.bufferSize).fill(0);

    this.animationId = null;
    this.isRunning = false;

    // FIX 4: Track when we last received updates
    this.lastUpdateTime = 0;
    this.warningShown = false;
  }

  start() {
    this.isRunning = true;
    this.container.style.display = 'flex';
    this.micBuffer.fill(0);
    this.desktopBuffer.fill(0);
    this.lastUpdateTime = Date.now(); // Initialize update time
    this.warningShown = false;
    // Use setInterval instead of requestAnimationFrame
    // This ensures visualization continues even when window is backgrounded
    this.animationId = setInterval(() => this.draw(), 50); // 20 FPS
  }

  stop() {
    this.isRunning = false;
    if (this.animationId) {
      clearInterval(this.animationId);
      this.animationId = null;
    }
    // Keep visible for a moment or hide immediately?
    // Let's hide it to keep UI clean when not recording
    this.container.style.display = 'none';
    this.warningShown = false;
  }

  updateLevels(levels) {
    // FIX 4: Update timestamp when we receive levels
    this.lastUpdateTime = Date.now();
    this.warningShown = false; // Reset warning when we get updates

    // Shift buffer and add new level
    this.micBuffer.shift();
    this.micBuffer.push(levels.mic);

    this.desktopBuffer.shift();
    this.desktopBuffer.push(levels.desktop);
  }

  draw() {
    if (!this.isRunning) return;

    // PERFORMANCE: Skip rendering if document is hidden (minimized/backgrounded)
    // Saves CPU/GPU when user can't see the visualization
    if (document.hidden) {
      return; // Don't render, but keep interval running for quick resume
    }

    // FIX 4: Check if we've received updates recently
    const timeSinceUpdate = Date.now() - this.lastUpdateTime;

    // If no updates for 5 seconds, fade out visualization to indicate problem
    if (timeSinceUpdate > 5000) {
      // PERFORMANCE: In-place mutation instead of creating new array
      for (let i = 0; i < this.micBuffer.length; i++) {
        this.micBuffer[i] *= 0.9;
        this.desktopBuffer[i] *= 0.9;
      }

      // Show warning once
      if (!this.warningShown && recordingState === 'recording') {
        console.warn('Visualizer: No audio levels for 5s - recording may be paused');
        addLog('⚠️ Warning: Audio visualization paused (no data from recorder)', 'warning');
        this.warningShown = true;
      }
    }

    this.drawWaveform(this.micCtx, this.micBuffer, '#10b981'); // Emerald 500
    this.drawWaveform(this.desktopCtx, this.desktopBuffer, '#3b82f6'); // Blue 500

    // No longer using requestAnimationFrame - we use setInterval in start()
  }

  drawWaveform(ctx, buffer, color) {
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    const barWidth = width / this.bufferSize;

    // Clear canvas
    ctx.clearRect(0, 0, width, height);

    // Draw bars
    ctx.fillStyle = color;
    
    for (let i = 0; i < this.bufferSize; i++) {
      const level = buffer[i];
      // Non-linear scaling for better visual feedback on low volumes
      const scaledLevel = Math.pow(level, 0.5); 
      
      const barHeight = Math.max(2, scaledLevel * height);
      const x = i * barWidth;
      const y = (height - barHeight) / 2; // Center vertically

      // Draw rounded bar
      this.roundRect(ctx, x, y, barWidth - 1, barHeight, 1);
      ctx.fill();
    }
  }

  // Helper for rounded rectangles
  roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }
}

// Handle page visibility changes (for debugging backgrounded recording)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    console.log('App backgrounded - recording should continue');
  } else {
    console.log('App foregrounded - resuming visualization');
  }
});

// Start the app
init();
setupTabs();
initSettingsTab();

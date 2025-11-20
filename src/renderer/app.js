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
let recordingState = 'idle'; // idle, recording, stopping, transcribing
let recordingStartTime = null;
let timerInterval = null;
let currentAudioFile = null;
let currentMeetingId = null;
let meetings = [];
let audioVisualizer = null;

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

// Initialize app
async function init() {
  await loadAudioDevices();
  await loadMeetingHistory();
  
  // Initialize visualizer
  audioVisualizer = new AudioVisualizer();
  
  setupEventListeners();
  console.log('App initialized');
}

// Load audio devices
async function loadAudioDevices() {
  try {
    addLog('Loading audio devices...');
    const devices = await window.electronAPI.getAudioDevices();

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
    meetings = await window.electronAPI.listMeetings();
    renderMeetingList();
    console.log(`Loaded ${meetings.length} meetings`);
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
  meetings.forEach(meeting => {
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
      // Don't select if clicking delete button
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
  if (!meeting) return;

  // Update selection
  document.querySelectorAll('.meeting-item').forEach(item => {
    item.classList.toggle('selected', item.dataset.id === meetingId);
  });

  currentMeetingId = meetingId;

  // Show meeting details
  document.getElementById('meeting-title').textContent = meeting.title;
  document.getElementById('meeting-date').textContent = formatDate(meeting.date);
  document.getElementById('meeting-duration').textContent = meeting.duration;

  // Load audio - Convert path to file:// URL for Electron
  const audioPlayer = document.getElementById('audio-player');
  const audioPath = meeting.audioPath.replace(/\\/g, '/'); // Normalize path separators

  // For Opus files, we need to use the file:// protocol
  if (audioPath.startsWith('/') || audioPath.startsWith('C:') || audioPath.startsWith('D:')) {
    audioPlayer.src = 'file:///' + audioPath.replace(/^\//, '');
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
  // deleteMeeting.addEventListener('click', deleteMeetingHandler); // Removed old handler

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
}

// Handle record button click
function handleRecordButtonClick() {
  if (recordingState === 'idle') {
    startRecording();
  } else if (recordingState === 'recording') {
    stopRecording();
  }
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
  }
}

// Update other controls based on state
function updateControlsState() {
  const isBusy = recordingState !== 'idle';
  
  micSelect.disabled = isBusy;
  desktopSelect.disabled = isBusy;
  languageSelect.disabled = isBusy;
  modelSelect.disabled = isBusy;
  refreshBtn.disabled = isBusy;
}

// Start recording
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

  try {
    addLog('Starting recording...');

    await window.electronAPI.startRecording({
      micId: parseInt(micId),
      loopbackId: parseInt(desktopId)
    });

    setRecordingState('recording');
    recordingStartTime = Date.now();

    // Update UI
    startTimer();
    audioVisualizer.start();

    // Clear previous transcript
    transcriptOutput.innerHTML = '<p class="placeholder">Recording in progress...</p>';
    transcriptActions.style.display = 'none';

    addLog('Recording started!');
  } catch (error) {
    console.error('Failed to start recording:', error);
    addLog(`Error: ${error.message}`, 'error');
    setRecordingState('idle');
  }
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

    // Display transcript
    transcriptOutput.innerHTML = '';
    const transcriptText = document.createElement('div');
    transcriptText.textContent = result.text || 'No transcription available';
    transcriptOutput.appendChild(transcriptText);

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
  if (!idToDelete) return;

  const meeting = meetings.find(m => m.id === idToDelete);
  if (!meeting) return;

  if (confirm(`Are you sure you want to delete "${meeting.title}"?`)) {
    try {
      addLog(`Deleting meeting: ${meeting.title}...`);
      await window.electronAPI.deleteMeeting(idToDelete);

      // If we deleted the currently selected meeting, clear the view
      if (currentMeetingId === idToDelete) {
        meetingDetails.style.display = 'none';
        document.getElementById('meeting-details-empty').style.display = 'flex';
        currentMeetingId = null;
      }

      // Reload list
      await loadMeetingHistory();

      addLog('Meeting deleted successfully!');
    } catch (error) {
      console.error('Failed to delete meeting:', error);
      addLog(`Error: Failed to delete meeting`, 'error');
      alert('Failed to delete meeting: ' + error.message);
    }
  }
}

// Update recording UI state - DEPRECATED, using setRecordingState instead
// Kept empty to prevent errors if called elsewhere
function updateRecordingUI(recording) {
  // No-op
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
  const gpuDetected = document.getElementById('gpu-detected');
  const cudaStatus = document.getElementById('cuda-status');
  const installBtn = document.getElementById('install-gpu-btn');
  const uninstallBtn = document.getElementById('uninstall-gpu-btn');

  statusBadge.textContent = 'Checking...';
  statusBadge.className = 'setting-badge';

  try {
    // Check if GPU exists
    const gpuInfo = await window.electronAPI.checkGPU();

    if (gpuInfo.hasGPU) {
      gpuDetected.textContent = gpuInfo.gpuName;
      gpuDetected.classList.add('success');
    } else {
      gpuDetected.textContent = 'No NVIDIA GPU detected';
      gpuDetected.classList.add('error');
      statusBadge.textContent = 'Not Available';
      statusBadge.classList.add('disabled');
      installBtn.disabled = true;
      return;
    }

    // Check CUDA installation
    const cudaInfo = await window.electronAPI.checkCUDA();

    if (cudaInfo.installed) {
      cudaStatus.textContent = `Installed (CUDA ${cudaInfo.version})`;
      cudaStatus.classList.add('success');
      statusBadge.textContent = 'Enabled';
      statusBadge.classList.add('enabled');
      installBtn.style.display = 'none';
      uninstallBtn.style.display = 'block';
    } else {
      cudaStatus.textContent = 'Not installed';
      cudaStatus.classList.add('warning');
      statusBadge.textContent = 'Available';
      statusBadge.classList.add('disabled');
      installBtn.disabled = false;
      installBtn.style.display = 'block';
      uninstallBtn.style.display = 'none';
    }
  } catch (error) {
    console.error('Failed to check GPU status:', error);
    statusBadge.textContent = 'Error';
    statusBadge.classList.add('disabled');
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
  }

  start() {
    this.isRunning = true;
    this.container.style.display = 'flex';
    this.micBuffer.fill(0);
    this.desktopBuffer.fill(0);
    this.draw();
  }

  stop() {
    this.isRunning = false;
    if (this.animationId) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    // Keep visible for a moment or hide immediately?
    // Let's hide it to keep UI clean when not recording
    this.container.style.display = 'none';
  }

  updateLevels(levels) {
    // Shift buffer and add new level
    this.micBuffer.shift();
    this.micBuffer.push(levels.mic);
    
    this.desktopBuffer.shift();
    this.desktopBuffer.push(levels.desktop);
  }

  draw() {
    if (!this.isRunning) return;

    this.drawWaveform(this.micCtx, this.micBuffer, '#10b981'); // Emerald 500
    this.drawWaveform(this.desktopCtx, this.desktopBuffer, '#3b82f6'); // Blue 500

    this.animationId = requestAnimationFrame(() => this.draw());
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

// Start the app
init();
setupTabs();
initSettingsTab();

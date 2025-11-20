/**
 * Renderer process - UI logic for Meeting Transcriber (Redesigned)
 */

// UI Elements
const micSelect = document.getElementById('mic-select');
const desktopSelect = document.getElementById('desktop-select');
const languageSelect = document.getElementById('language-select');
const modelSelect = document.getElementById('model-select');
const refreshBtn = document.getElementById('refresh-devices');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
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
let isRecording = false;
let recordingStartTime = null;
let timerInterval = null;
let currentAudioFile = null;
let currentMeetingId = null;
let meetings = [];

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
  startBtn.addEventListener('click', startRecording);
  stopBtn.addEventListener('click', stopRecording);
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

    isRecording = true;
    recordingStartTime = Date.now();

    // Update UI
    updateRecordingUI(true);
    startTimer();

    // Clear previous transcript
    transcriptOutput.innerHTML = '<p class="placeholder">Recording in progress...</p>';
    transcriptActions.style.display = 'none';

    addLog('Recording started!');
  } catch (error) {
    console.error('Failed to start recording:', error);
    addLog(`Error: ${error.message}`, 'error');
  }
}

// Stop recording and auto-transcribe
async function stopRecording() {
  try {
    addLog('Stopping recording...');

    await window.electronAPI.stopRecording();

    isRecording = false;
    stopTimer();

    // Update UI
    updateRecordingUI(false);

    addLog('Recording stopped! Starting transcription...');

    // Auto-transcribe
    await transcribeAudio();

  } catch (error) {
    console.error('Failed to stop recording:', error);
    addLog(`Error: ${error.message}`, 'error');
  }
}

// Transcribe audio (auto-called after stop)
async function transcribeAudio() {
  const language = languageSelect.value;
  const modelSize = modelSelect.value;

  try {
    statusText.textContent = 'Transcribing...';
    transcriptOutput.innerHTML = '<p class="placeholder">Transcribing... This may take a moment.</p>';

    addLog('Starting transcription...');
    addLog(`Language: ${language}, Model: ${modelSize}`);

    const result = await window.electronAPI.transcribeAudio({
      audioFile: currentAudioFile || '../recordings/temp.wav',
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

    statusText.textContent = 'Transcription complete!';
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

  } catch (error) {
    console.error('Failed to transcribe:', error);
    addLog(`Error: ${error.message}`, 'error');
    transcriptOutput.innerHTML = `<p class="placeholder error">Transcription failed: ${error.message}</p>`;
    statusText.textContent = 'Transcription failed';
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

// Update recording UI state
function updateRecordingUI(recording) {
  if (recording) {
    statusIndicator.classList.add('recording');
    statusText.textContent = 'Recording...';
    startBtn.disabled = true;
    stopBtn.disabled = false;
    micSelect.disabled = true;
    desktopSelect.disabled = true;
    languageSelect.disabled = true;
    modelSelect.disabled = true;
    refreshBtn.disabled = true;
  } else {
    statusIndicator.classList.remove('recording');
    statusText.textContent = 'Processing...';
    startBtn.disabled = false;
    stopBtn.disabled = true;
    micSelect.disabled = false;
    desktopSelect.disabled = false;
    languageSelect.disabled = false;
    modelSelect.disabled = false;
    refreshBtn.disabled = false;
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

// Start the app
init();
setupTabs();
initSettingsTab();

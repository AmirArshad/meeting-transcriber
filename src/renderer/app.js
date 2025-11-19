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
  } catch (error) {
    console.error('Failed to load devices:', error);
    addLog(`Error: ${error.message}`, 'error');
  }
}

// Load meeting history
async function loadMeetingHistory() {
  try {
    // TODO: Implement this with IPC call to main process
    // For now, show placeholder
    meetings = [];
    renderMeetingList();
  } catch (error) {
    console.error('Failed to load meeting history:', error);
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
      <div class="meeting-item-title">${meeting.title}</div>
      <div class="meeting-item-date">${formatDate(meeting.date)}</div>
      <div class="meeting-item-duration">${meeting.duration}</div>
    `;

    item.addEventListener('click', () => selectMeeting(meeting.id));
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
  document.getElementById('meeting-date').textContent = `Date: ${formatDate(meeting.date)}`;
  document.getElementById('meeting-duration').textContent = `Duration: ${meeting.duration}`;

  // Load audio
  const audioSource = document.getElementById('audio-source');
  audioSource.src = meeting.audioPath;
  document.getElementById('audio-player').load();

  // Load transcript
  document.getElementById('meeting-transcript').textContent = meeting.transcript || 'No transcript available';

  // Show details panel
  meetingDetails.style.display = 'block';
}

// Setup event listeners
function setupEventListeners() {
  refreshBtn.addEventListener('click', loadAudioDevices);
  refreshHistory.addEventListener('click', loadMeetingHistory);
  startBtn.addEventListener('click', startRecording);
  stopBtn.addEventListener('click', stopRecording);
  copyBtn.addEventListener('click', copyTranscript);
  saveBtn.addEventListener('click', saveTranscript);
  deleteMeeting.addEventListener('click', deleteMeetingHandler);

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

    // Reload meeting history
    await loadMeetingHistory();

  } catch (error) {
    console.error('Failed to transcribe:', error);
    addLog(`Error: ${error.message}`, 'error');
    transcriptOutput.innerHTML = `<p class="placeholder error">Transcription failed: ${error.message}</p>`;
    statusText.textContent = 'Transcription failed';
  }
}

// Copy transcript to clipboard
function copyTranscript() {
  const text = transcriptOutput.textContent;
  navigator.clipboard.writeText(text);
  addLog('Transcript copied to clipboard!');
}

// Save transcript
function saveTranscript() {
  // TODO: Implement file save dialog via IPC
  addLog('Save feature coming soon!');
}

// Delete meeting
function deleteMeetingHandler() {
  if (!currentMeetingId) return;

  if (confirm('Are you sure you want to delete this meeting?')) {
    // TODO: Implement via IPC
    addLog('Delete feature coming soon!');
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

// Start the app
init();

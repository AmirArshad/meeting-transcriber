'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  ROOT,
  readUtf8,
} = require('./source-scan-helpers');

const {
  parseRecorderMessageLine,
  parseRecorderStdoutChunk,
  findRecorderResultPayload,
  getRecorderResultAudioPath,
  normalizeRecordingStopPayload,
  getRecorderEventAction,
} = require('../../src/main-process-helpers');

const WINDOWS_RECORDER = path.join(ROOT, 'backend', 'audio', 'windows_recorder.py');
const MACOS_RECORDER = path.join(ROOT, 'backend', 'audio', 'macos_recorder.py');
const RECORDER_SERVICE_JS = path.join(ROOT, 'src', 'main', 'recorder-service.js');

function assertEmitterDefinesFinalKey(source, keyName) {
  // Match dict/object literals that emit the platform final-result key.
  const patterns = [
    new RegExp(`['"]${keyName}['"]\\s*:`),
    new RegExp(`"${keyName}"\\s*:`),
    new RegExp(`'${keyName}'\\s*:`),
  ];
  assert.ok(
    patterns.some((pattern) => pattern.test(source)),
    `emitter source must include final-result key ${keyName}`,
  );
}

test('recorder stdout message shapes parse as levels/event/warning/error', () => {
  const levels = parseRecorderMessageLine('{"type":"levels","mic":0.1,"desktop":0.2}');
  assert.equal(levels.kind, 'levels');
  assert.deepEqual(levels.payload, { type: 'levels', mic: 0.1, desktop: 0.2 });

  const event = parseRecorderMessageLine(
    '{"type":"event","event":"recording_started","message":"Recording started"}',
  );
  assert.equal(event.kind, 'event');
  assert.equal(event.payload.event, 'recording_started');

  const warning = parseRecorderMessageLine(
    '{"type":"warning","code":"DESKTOP_AUDIO_DEGRADED","message":"Desktop audio weak"}',
  );
  assert.equal(warning.kind, 'warning');
  assert.equal(warning.payload.code, 'DESKTOP_AUDIO_DEGRADED');

  const error = parseRecorderMessageLine(
    '{"type":"error","code":"RECORDER_FAILED","message":"Recorder failed"}',
  );
  assert.equal(error.kind, 'error');
  assert.equal(error.payload.code, 'RECORDER_FAILED');
});

test('Windows recorder emitter uses audioPath in the final result payload', () => {
  const source = readUtf8(WINDOWS_RECORDER);
  assertEmitterDefinesFinalKey(source, 'audioPath');
  assert.equal(/['"]outputPath['"]\s*:/.test(source), false);

  // The final dict construction near main() must keep the Windows spelling.
  assert.match(
    source,
    /recording_info\s*=\s*\{[\s\S]*?["']audioPath["']\s*:/,
  );
});

test('macOS recorder emitter uses outputPath in the final result payload', () => {
  const source = readUtf8(MACOS_RECORDER);
  assertEmitterDefinesFinalKey(source, 'outputPath');

  // Success and recoverable-failure payloads both use the macOS spelling.
  assert.match(
    source,
    /['"]outputPath['"]\s*:\s*recovered_path(?:\s+or\s+args\.output)?/,
  );
  assert.match(source, /result\[['\"]outputPath['\"]\]\s*=\s*recovered_path/);
});

test('JS stop-result helpers accept both audioPath and outputPath spellings', () => {
  const windowsPayload = findRecorderResultPayload(
    '{"success":true,"audioPath":"C:\\\\recordings\\\\meeting.opus","duration":8.25}',
  );
  assert.equal(getRecorderResultAudioPath(windowsPayload), 'C:\\recordings\\meeting.opus');
  assert.deepEqual(
    normalizeRecordingStopPayload(windowsPayload, {
      existsSync: (filePath) => filePath === 'C:\\recordings\\meeting.opus',
    }),
    {
      success: true,
      audioPath: 'C:\\recordings\\meeting.opus',
      duration: 8.25,
      desktopDiagnostics: undefined,
    },
  );

  const macPayload = findRecorderResultPayload(
    '{"success":true,"outputPath":"/Users/me/recordings/meeting.opus","duration":12.5}',
  );
  assert.equal(getRecorderResultAudioPath(macPayload), '/Users/me/recordings/meeting.opus');
  assert.deepEqual(
    normalizeRecordingStopPayload(macPayload, { existsSync: () => true }),
    {
      success: true,
      audioPath: '/Users/me/recordings/meeting.opus',
      duration: 12.5,
      desktopDiagnostics: undefined,
    },
  );
});

test('structured stdout events drive control actions; stderr text is not a control channel', () => {
  const started = getRecorderEventAction({
    event: 'recording_started',
    message: 'Recording started',
  });
  assert.ok(started);

  const classified = parseRecorderStdoutChunk(
    '{"type":"event","event":"recording_started","message":"Recording started"}\n',
  );
  assert.ok(classified.messages.some((message) => message.kind === 'event'));

  const recorderServiceSource = readUtf8(RECORDER_SERVICE_JS);
  // stderr chunks append to debug/log buffers; they must not call getRecorderEventAction.
  assert.match(recorderServiceSource, /stderr\.on\(\s*['"]data['"]/);
  assert.equal(
    /stderr\.on\(\s*['"]data['"][\s\S]{0,400}getRecorderEventAction/.test(recorderServiceSource),
    false,
    'stderr data handler must not drive getRecorderEventAction',
  );
  assert.equal(
    /stderr\.on\(\s*['"]data['"][\s\S]{0,400}parseRecorderMessageLine/.test(recorderServiceSource),
    false,
    'stderr data handler must not parse structured recorder control messages',
  );
});

test('Windows and macOS recorders emit structured stdout helpers for levels/event/warning/error', () => {
  for (const filePath of [WINDOWS_RECORDER, MACOS_RECORDER]) {
    const source = readUtf8(filePath);
    assert.match(source, /def _send_event_message/);
    assert.match(source, /def _send_warning_message/);
    assert.match(source, /def _send_error_message/);
    assert.match(source, /["']type["']\s*:\s*["']levels["']/);
    assert.match(source, /print\(.*file=sys\.stderr/);
  }
});

test('Windows and macOS recorders emit structured stop-stage stdout events', () => {
  const requiredStages = [
    'post_processing_started',
    'audio_normalizing',
    'audio_mixing',
    'audio_encoding',
    'post_processing_complete',
  ];

  // Bounded finalization owns the stage sequence; recorders forward via progress_callback.
  const sppPath = path.join(ROOT, 'backend', 'audio', 'streaming_post_processor.py');
  const spp = readUtf8(sppPath);
  let lastPos = -1;
  for (const stage of requiredStages) {
    const pos = spp.indexOf(`"${stage}"`);
    assert.notEqual(pos, -1, `streaming_post_processor.py must emit ${stage}`);
    assert.ok(pos > lastPos, `streaming_post_processor.py stages must stay ordered (${stage})`);
    lastPos = pos;
  }

  for (const filePath of [WINDOWS_RECORDER, MACOS_RECORDER]) {
    const source = readUtf8(filePath);
    assert.match(source, /finalize_capture/);
    assert.match(source, /progress_callback/);
    assert.match(source, /_send_event_message\(stage/);
  }

  for (const stage of requiredStages) {
    const action = getRecorderEventAction({
      event: stage,
      message: `stage:${stage}`,
    });
    assert.equal(action.progressMessage, `stage:${stage}`);
    assert.equal(action.recordingStartedMessage, null);
    assert.equal(action.initProgress, null);
  }
});

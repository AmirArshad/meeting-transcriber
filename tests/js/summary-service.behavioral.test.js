'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createSummaryService } = require('../../src/main/summary-service');
const { createAiAddonCancelErrorStandalone } = require('../../src/main/ai-addon-ipc');

function createProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  return proc;
}

function createHarness({ summaryExitCode = 0, metadataOutput = null, previousSummary = null } = {}) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-summary-service-'));
  const recordingsDir = path.join(userData, 'recordings');
  fs.mkdirSync(recordingsDir, { recursive: true });
  const transcriptPath = path.join(recordingsDir, 'meeting.md');
  const previousOutputJson = path.join(recordingsDir, 'meeting.summary.json');
  const previousOutputMarkdown = path.join(recordingsDir, 'meeting.summary.md');
  let generatedOutputJson = null;
  let generatedOutputMarkdown = null;
  fs.writeFileSync(transcriptPath, '# Meeting\n');

  const meeting = {
    id: 'meeting_1',
    transcriptPath,
    transcriptionStatus: 'completed',
    ai: {
      summary: previousSummary || {
        status: 'completed',
        jsonPath: previousOutputJson,
        markdownPath: previousOutputMarkdown,
      },
    },
  };
  const summaryResult = {
    metadata: {
      profile: 'balanced',
      model: 'test-model',
      generatedAt: '2026-07-10T00:00:00.000Z',
      sourceTranscriptHash: `sha256:${'a'.repeat(64)}`,
    },
    summary: { overview: 'new summary' },
  };

  const service = createSummaryService({
    app: { getPath: () => userData },
    path,
    fs,
    pythonConfig: { backendPath: recordingsDir },
    spawnTrackedPython(args) {
      const proc = createProcess();
      const joined = args.join(' ');
      if (joined.includes('meeting_manager') && joined.includes(' get ')) {
        setImmediate(() => {
          proc.stdout.emit('data', Buffer.from(JSON.stringify(meeting)));
          proc.emit('close', 0);
        });
      } else if (joined.includes('update-ai')) {
        setImmediate(() => {
          const metadataIndex = args.indexOf('--summary-json');
          const committedSummary = JSON.parse(args[metadataIndex + 1]);
          proc.stdout.emit('data', Buffer.from(metadataOutput ?? JSON.stringify({
            ...meeting,
            ai: { summary: committedSummary },
          })));
          proc.emit('close', 0);
        });
      } else {
        setImmediate(() => {
          if (summaryExitCode === 0) {
            const outputJsonIndex = args.indexOf('--output-json');
            const outputMarkdownIndex = args.indexOf('--output-markdown');
            generatedOutputJson = args[outputJsonIndex + 1].replace(/\.tmp$/, '');
            generatedOutputMarkdown = args[outputMarkdownIndex + 1].replace(/\.tmp$/, '');
            fs.writeFileSync(args[outputJsonIndex + 1], JSON.stringify({ overview: 'new summary' }));
            fs.writeFileSync(args[outputMarkdownIndex + 1], '# New summary\n');
            proc.stdout.emit('data', Buffer.from(JSON.stringify(summaryResult)));
          } else {
            proc.stderr.emit('data', Buffer.from('summary generation failed'));
          }
          proc.emit('close', summaryExitCode);
        });
      }
      return proc;
    },
    getBackendModuleArgs: (moduleName, extraArgs = []) => ['-m', moduleName, ...extraArgs],
    enqueueAiComputeAction: (action) => action(),
    createAiAddonCancelError: createAiAddonCancelErrorStandalone,
    getAiAddonRuntimeOptions: () => ({}),
    buildSummaryArgs: (options) => [
      '-m', 'summaries.summary_runner',
      '--output-json', options.outputJson,
      '--output-markdown', options.outputMarkdown,
    ],
    collectPythonProcessOutput(python) {
      let stdout = '';
      let stderr = '';
      python.stdout.on('data', (data) => { stdout += data.toString(); });
      python.stderr.on('data', (data) => { stderr += data.toString(); });
      return {
        getStdout: () => stdout,
        getStderr: () => stderr,
        assertStdoutWithinLimit() {},
      };
    },
    sendToRenderer() {},
    appendSpawnLogBuffer: (buffer, chunk) => buffer + String(chunk),
    appendSpawnJsonStdout: (buffer, chunk) => buffer + String(chunk),
    assertTrustedRendererSender() {},
    assertSafeExistingTranscriptPath: (value) => value,
    assertSafeExistingSegmentsPath: (value) => value,
    terminateProcessBestEffort: async (proc) => proc?.kill(),
    summarizeSummaryValidationError: (value) => value || 'summary failed',
    checkAiAddonSetupStatus: async () => ({
      features: { summary: { status: 'ready', setupComplete: true, modelId: 'test-model' } },
    }),
    getSummaryArtifactForPlatform: () => ({ modelId: 'test-model', modelLabel: 'Test', filename: 'model.gguf' }),
    getSummaryArtifactPath: () => path.join(userData, 'model.gguf'),
    getSummaryRuntimeDir: () => path.join(userData, 'runtime'),
  });

  const handlers = {};
  service.registerIpc({ handle(channel, handler) { handlers[channel] = handler; } });
  return {
    handlers,
    recordingsDir,
    transcriptPath,
    outputJson: previousOutputJson,
    outputMarkdown: previousOutputMarkdown,
    getGeneratedPaths: () => ({ outputJson: generatedOutputJson, outputMarkdown: generatedOutputMarkdown }),
  };
}

test('failed summary regeneration preserves the previously committed sidecars', async () => {
  const { handlers, outputJson, outputMarkdown } = createHarness({ summaryExitCode: 1 });
  fs.writeFileSync(outputJson, '{"overview":"old summary"}');
  fs.writeFileSync(outputMarkdown, '# Old summary\n');

  await assert.rejects(
    handlers['generate-summary']({ sender: {} }, { meetingId: 'meeting_1' }),
    /summary generation failed/,
  );

  assert.equal(fs.readFileSync(outputJson, 'utf8'), '{"overview":"old summary"}');
  assert.equal(fs.readFileSync(outputMarkdown, 'utf8'), '# Old summary\n');
});

test('successful metadata commit remains successful when update-ai stdout is malformed', async () => {
  const { handlers, outputJson, outputMarkdown, getGeneratedPaths } = createHarness({ metadataOutput: '{not-json' });
  fs.writeFileSync(outputJson, '{"overview":"old summary"}');
  fs.writeFileSync(outputMarkdown, '# Old summary\n');

  const result = await handlers['generate-summary']({ sender: {} }, { meetingId: 'meeting_1' });

  const generated = getGeneratedPaths();
  assert.equal(fs.readFileSync(generated.outputJson, 'utf8'), '{"overview":"new summary"}');
  assert.equal(fs.readFileSync(generated.outputMarkdown, 'utf8'), '# New summary\n');
  assert.equal(fs.existsSync(outputJson), false);
  assert.equal(fs.existsSync(outputMarkdown), false);
  assert.equal(result.meeting.ai.summary.status, 'completed');
  assert.equal(result.meeting.ai.summary.jsonPath, generated.outputJson);
});

test('successful summary cleanup removes only same-meeting summary sidecars', async () => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-summary-outside-'));
  const outsidePath = path.join(outsideDir, 'meeting.summary.json');
  fs.writeFileSync(outsidePath, 'outside');

  const harness = createHarness({
    previousSummary: {
      status: 'completed',
      jsonPath: null,
      markdownPath: null,
    },
  });
  const otherMeetingSummary = path.join(harness.recordingsDir, 'other.summary.md');
  const speakerSidecar = path.join(harness.recordingsDir, 'meeting.speakers.json');
  const orphanJson = path.join(harness.recordingsDir, 'meeting.100-200-300.summary.json');
  const orphanMarkdown = path.join(harness.recordingsDir, 'meeting.100-200-300.summary.md');
  fs.writeFileSync(otherMeetingSummary, 'other');
  fs.writeFileSync(speakerSidecar, 'speakers');
  fs.writeFileSync(orphanJson, 'orphan json');
  fs.writeFileSync(orphanMarkdown, 'orphan markdown');
  const meeting = await harness.handlers['generate-summary'](
    { sender: {} },
    { meetingId: 'meeting_1' },
  );

  assert.equal(fs.existsSync(harness.transcriptPath), true);
  assert.equal(fs.existsSync(otherMeetingSummary), true);
  assert.equal(fs.existsSync(speakerSidecar), true);
  assert.equal(fs.existsSync(outsidePath), true);
  assert.equal(fs.existsSync(orphanJson), false);
  assert.equal(fs.existsSync(orphanMarkdown), false);
  assert.equal(fs.existsSync(meeting.jsonPath), true);
  assert.equal(fs.existsSync(meeting.markdownPath), true);
});

for (const hostilePathKind of ['transcript', 'other-meeting', 'outside']) {
  test(`hostile previous summary metadata cannot delete ${hostilePathKind} files`, async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'avanevis-summary-hostile-'));
    const harness = createHarness();
    const otherMeetingSummary = path.join(harness.recordingsDir, 'other.summary.json');
    const outsideSummary = path.join(outsideDir, 'meeting.summary.json');
    fs.writeFileSync(otherMeetingSummary, 'other');
    fs.writeFileSync(outsideSummary, 'outside');
    const hostilePath = hostilePathKind === 'transcript'
      ? harness.transcriptPath
      : hostilePathKind === 'other-meeting'
        ? otherMeetingSummary
        : outsideSummary;

    // The preflight meeting object is closed over by the harness; mutate the
    // returned metadata through the file paths it exposes before generation.
    const preflightProcMeeting = {
      status: 'completed',
      jsonPath: hostilePath,
      markdownPath: hostilePath,
    };
    // Rebuild with hostile persisted metadata so real generate-summary cleanup runs.
    const hostileHarness = createHarness({ previousSummary: preflightProcMeeting });
    const hostileOther = path.join(hostileHarness.recordingsDir, 'other.summary.json');
    if (hostilePathKind === 'other-meeting') {
      preflightProcMeeting.jsonPath = hostileOther;
      preflightProcMeeting.markdownPath = hostileOther;
      fs.writeFileSync(hostileOther, 'other');
    } else if (hostilePathKind === 'transcript') {
      preflightProcMeeting.jsonPath = hostileHarness.transcriptPath;
      preflightProcMeeting.markdownPath = hostileHarness.transcriptPath;
    }

    await hostileHarness.handlers['generate-summary']({ sender: {} }, { meetingId: 'meeting_1' });
    const protectedPath = hostilePathKind === 'transcript'
      ? hostileHarness.transcriptPath
      : hostilePathKind === 'other-meeting'
        ? hostileOther
        : outsideSummary;
    assert.equal(fs.existsSync(protectedPath), true);
  });
}

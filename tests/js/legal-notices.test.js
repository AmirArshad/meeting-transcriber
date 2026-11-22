const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { getLegalNoticesPath } = require('../../src/main-process-helpers');

const repoRoot = path.join(__dirname, '..', '..');

test('THIRD_PARTY_NOTICES.md exists and documents key optional models', () => {
  const noticesPath = path.join(repoRoot, 'THIRD_PARTY_NOTICES.md');
  assert.equal(fs.existsSync(noticesPath), true);

  const contents = fs.readFileSync(noticesPath, 'utf8');
  assert.match(contents, /pyannote\/speaker-diarization-community-1/i);
  assert.match(contents, /CC BY 4\.0/i);
  assert.match(contents, /Speakrs/i);
  assert.match(contents, /speakrs-cli/i);
  assert.match(contents, /avencera\/speakrs/i);
  assert.match(contents, /Qwen/i);
  assert.match(contents, /Prism ML/i);
  assert.match(contents, /Bonsai 2/i);
  assert.match(contents, /Mistral AI/i);
  assert.match(contents, /Ministral 3/i);
  assert.match(contents, /parakeet-tdt-0\.6b-v2/i);
  assert.match(contents, /marked/i);
  assert.match(contents, /dompurify/i);
  assert.match(contents, /ffmpeg/i);
  assert.match(contents, /GPL/i);
});

test('notices and model catalog agree on official and legacy summary runtime licenses', () => {
  const notices = fs.readFileSync(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  const catalog = fs.readFileSync(path.join(repoRoot, 'docs', 'development', 'LOCAL_AI_MODEL_CATALOG.md'), 'utf8');
  for (const document of [notices, catalog]) {
    assert.match(document, /ggml-org\/llama\.cpp/);
    assert.match(document, /official [^\n]*`b12631`/i);
    assert.match(document, /`cudart-llama-b12631-bin-ubuntu-cuda-12\.8-x64\.tar\.gz`/);
    assert.match(document, /`cudart-llama-bin-win-cuda-12\.4-x64\.zip`/);
    assert.match(document, /NVIDIA CUDA Toolkit EULA/);
  }
  assert.match(notices, /ai-dock\/llama\.cpp-cuda[^\n]*legacy Linux Qwen3\.5[^\n]*`v0\.3\.0`/);
  assert.match(notices, /NCCL wheel[^\n]*`nvidia\/nccl\/lib\/LICENSE\.txt`[^\n]*only by the legacy Linux Qwen3\.5/);
  assert.match(catalog, /Linux Qwen3\.5 summary lane uses[^\n]*\n`llama-cpp-v0\.3\.0-linux-x64-cuda-12\.8`: ai-dock/);
  assert.match(catalog.replace(/\s+/g, ' '), /NCCL wheel is used only by the legacy Linux Qwen3\.5 summary runtime and carries the NVIDIA Software License Agreement at `nvidia\/nccl\/lib\/LICENSE\.txt`/);
  assert.match(catalog, /no NCCL dependency/);
});

test('getLegalNoticesPath prefers packaged resources/legal when present', () => {
  const tempResources = path.join(repoRoot, 'tests', 'fixtures', 'legal-notices-packaged');
  const packagedNotices = path.join(tempResources, 'legal', 'THIRD_PARTY_NOTICES.md');
  fs.mkdirSync(path.dirname(packagedNotices), { recursive: true });
  fs.writeFileSync(packagedNotices, '# Packaged notices\n', 'utf8');

  try {
    const resolved = getLegalNoticesPath({
      resourcesPath: tempResources,
      devRoot: repoRoot,
    });
    assert.equal(resolved, packagedNotices);
  } finally {
    fs.rmSync(tempResources, { recursive: true, force: true });
  }
});

test('getLegalNoticesPath falls back to repository root in development', () => {
  const resolved = getLegalNoticesPath({
    resourcesPath: path.join(repoRoot, 'missing-resources'),
    devRoot: repoRoot,
  });
  assert.equal(resolved, path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'));
});

test('Settings About credits name Speakrs, pyannote, and Parakeet', () => {
  const aboutHtml = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'index.html'), 'utf8');
  assert.match(aboutHtml, /class="about-credits"/);
  assert.match(aboutHtml, /NVIDIA Parakeet/);
  assert.match(aboutHtml, /parakeet-tdt-0\.6b-v2/);
  assert.match(aboutHtml, /https:\/\/github\.com\/avencera\/speakrs/);
  assert.match(aboutHtml, />Speakrs</);
  assert.match(aboutHtml, /Apache-2\.0/);
  assert.match(aboutHtml, /pyannote Speaker Diarization Community-1/);
  assert.match(aboutHtml, /Prism ML Bonsai 2/);
  assert.match(aboutHtml, /Mistral AI Ministral 3/);
  assert.match(aboutHtml, /Speakrs CLI/);
});

# Speakrs model-pack attribution

These notices apply to the optional Speakrs model packs distributed by AvaNevis.
The packs select files from `avencera/speakrs-models` at immutable revision
`5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f`.

## pyannote segmentation 3.0

- Title: `pyannote/segmentation-3.0`
- Author: pyannoteAI / CNRS
- Source: https://huggingface.co/pyannote/segmentation-3.0
- Repacked source revision: https://huggingface.co/avencera/speakrs-models/tree/5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f
- License: MIT — https://github.com/pyannote/pyannote-audio/blob/develop/LICENSE
- Copyright notice: Copyright (c) 2020 CNRS
- Changes: converted upstream to ONNX/CoreML and repackaged for AvaNevis; weights are unmodified by AvaNevis.

The complete notice is in `LICENSES/MIT-pyannote.txt`.

## WeSpeaker VoxCeleb ResNet34-LM

- Title: `wespeaker-voxceleb-resnet34-LM`
- Author: WeSpeaker contributors; converted for the pyannote/Speakrs pipeline by upstream authors
- Source: https://github.com/wenet-e2e/wespeaker
- Repacked source revision: https://huggingface.co/avencera/speakrs-models/tree/5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f
- License: CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/
- Changes: converted upstream to ONNX/CoreML and repackaged for AvaNevis; weights are unmodified by AvaNevis.

The complete license is in `LICENSES/CC-BY-4.0.txt`.

## PLDA and VBx parameters

- Title: PLDA/VBx parameters from `pyannote/speaker-diarization-community-1`
- Author: pyannoteAI
- Source: https://huggingface.co/pyannote/speaker-diarization-community-1
- Repacked source revision: https://huggingface.co/avencera/speakrs-models/tree/5d24ffee75f13fb061fa6d10944a64e2dc1d5e6f
- License: CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/
- Changes: extracted by upstream for the Speakrs pipeline and repackaged for AvaNevis; parameters are unmodified by AvaNevis.

The complete license is in `LICENSES/CC-BY-4.0.txt`.

## Speakrs

- Title: `speakrs` 0.5.0
- Author: avencera / Praveen Perera
- Source: https://github.com/avencera/speakrs/tree/v0.5.0
- License: Apache License 2.0 — https://github.com/avencera/speakrs/blob/v0.5.0/LICENSE
- Copyright notice: Copyright 2026 Praveen Perera
- Changes: AvaNevis uses an offline, platform-specific subset of the model files selected by Speakrs and repackages that subset with attribution; the model weights are unmodified by AvaNevis.

The complete license is in `LICENSES/Apache-2.0.txt`.

## ONNX Runtime

- Title: ONNX Runtime 1.27.1 CUDA 12 runtime
- Author: Microsoft Corporation
- Source: https://github.com/microsoft/onnxruntime/releases/tag/v1.27.1
- License: MIT — https://github.com/microsoft/onnxruntime/blob/v1.27.1/LICENSE
- Copyright notice: Copyright (c) Microsoft Corporation
- Changes: AvaNevis selectively extracts the five runtime DLLs required by Speakrs; the DLL binaries are unmodified.

The complete notice is in `LICENSES/MIT-onnxruntime.txt`.

## Repackaging notice

AvaNevis adds this attribution document and the complete license texts under
`LICENSES/`, selects only the platform files required by Speakrs, preserves
nested CoreML bundle paths, and creates a new deterministic archive. No model
weights or runtime binaries are modified by AvaNevis.

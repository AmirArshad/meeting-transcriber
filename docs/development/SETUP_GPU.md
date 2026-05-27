# GPU Setup Guide for AvaNevis

This guide helps you set up GPU acceleration for faster transcription using AvaNevis-compatible CUDA runtime libraries.

## Prerequisites

- **NVIDIA GPU** with CUDA support (GTX 10xx series or newer recommended)
- **A recent NVIDIA driver** visible to `nvidia-smi`
- **Windows 10/11** for AvaNevis packaged CUDA transcription acceleration

## Quick Setup

### Step 1: Verify NVIDIA Driver/GPU Visibility

Open PowerShell and check whether Windows can see the NVIDIA GPU:

```powershell
nvidia-smi
```

You should see your GPU listed with driver version and the maximum CUDA API version supported by the driver. This does not mean AvaNevis can use every installed CUDA runtime major.

### Step 2: Install CUDA 12 Runtime Libraries for faster-whisper

```bash
pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

**Note:** This is about a 1GB download. AvaNevis transcription uses faster-whisper/CTranslate2 and currently targets the CUDA 12 runtime profile, so PyTorch and the CUDA Toolkit are not required for transcription acceleration.

### Step 3: Install Project Dependencies

```bash
pip install -r requirements.txt
```

### Step 4: Verify GPU is Working

Run this quick test:

```python
import ctranslate2
print(f"CUDA devices: {ctranslate2.get_cuda_device_count()}")
```

## Troubleshooting

### Error: "Could not locate cudnn_ops64_9.dll"

**Solution:** Install the cuDNN library:
```bash
pip install nvidia-cudnn-cu12
```

### Error: "CUDA out of memory"

**Solution:** Use a smaller Whisper model:
- Try `base` instead of `medium`
- Try `small` instead of `medium`
- Try `tiny` for very limited VRAM

### Error: "No CUDA-capable device detected"

**Solutions:**
1. Update your NVIDIA drivers to the latest version
2. Verify the NVIDIA driver sees your GPU: `nvidia-smi`
3. Check if your GPU supports CUDA: [NVIDIA GPU Compute Capability](https://developer.nvidia.com/cuda-gpus)

### Transcriber Falls Back to CPU

If you see "Using CPU (safer default)" in the logs but you have CUDA installed:

1. Verify CTranslate2 detects CUDA:
    ```python
    import ctranslate2
    print(ctranslate2.get_cuda_device_count())
    ```

2. If it returns `0`, repair CUDA runtime libraries:
    ```bash
    pip install --upgrade --force-reinstall --no-cache-dir nvidia-cublas-cu12 nvidia-cudnn-cu12
    ```

### Newer CUDA major detected (for example CUDA 13)

AvaNevis currently ships transcription dependencies validated against the CUDA 12 runtime profile (`nvidia-cublas-cu12` + `nvidia-cudnn-cu12`).
If your machine has only newer runtime DLLs (for example `cublas64_13.dll`) and not CUDA 12 runtime DLLs, AvaNevis will detect this mismatch and safely fall back to CPU transcription.

Use the in-app **Repair GPU Runtime** action to add the CUDA 12 libraries AvaNevis needs. This does not remove newer CUDA runtime libraries used by other applications.

Speaker identification is separate: it uses managed PyTorch CUDA dependencies under Electron `userData` only after explicit speaker setup.

## Performance Comparison

With GPU acceleration, transcription is **4-5x faster**:

| Model  | CPU (approx) | GPU (approx) | Quality        |
|--------|--------------|--------------|----------------|
| tiny   | 0.5x realtime| 2x realtime  | Basic          |
| base   | 0.3x realtime| 1.5x realtime| Good           |
| small  | 0.2x realtime| 1x realtime  | Better         |
| medium | 0.1x realtime| 0.5x realtime| Excellent      |
| large  | 0.05x realtime| 0.3x realtime| Best           |

**Example:** A 10-minute recording:
- **CPU (base model):** ~30 minutes to transcribe
- **GPU (base model):** ~6 minutes to transcribe
- **GPU (medium model):** ~20 minutes to transcribe (but much better accuracy!)

## Recommended Setup

For best experience:
- **GPU users:** Use `medium` model with CUDA
- **CPU users:** Use `base` or `small` model
- **Fast preview:** Use `tiny` model

## Still Having Issues?

1. Check the [faster-whisper GitHub](https://github.com/SYSTRAN/faster-whisper) for latest updates
2. Try CPU mode first to verify the rest works: The transcriber will auto-fallback to CPU if GPU fails
3. Report issues with full error logs

---

**Ready to test?** Run:
```bash
python test_transcribe.py
```

You should see: `CUDA detected, using GPU acceleration`

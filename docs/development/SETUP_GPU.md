# GPU Setup Guide for Meeting Transcriber

This guide helps you set up GPU acceleration for faster transcription using CUDA.

## Prerequisites

- **NVIDIA GPU** with CUDA support (GTX 10xx series or newer recommended)
- **CUDA Toolkit** installed on your system (CUDA 11.8 or 12.1)
- **Windows 10/11** (for this project, though Linux/Mac also supported)

## Quick Setup

### Step 1: Verify CUDA Installation

Open PowerShell and check if CUDA is available:

```powershell
nvidia-smi
```

You should see your GPU listed with driver version and CUDA version.

### Step 2: Install PyTorch with CUDA Support

**IMPORTANT:** Install PyTorch BEFORE installing the other dependencies.

```bash
# For CUDA 12.1 (recommended for most modern GPUs):
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

# For CUDA 11.8 (older GPUs or older CUDA installation):
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
```

**Note:** This is a ~2GB download and may take a few minutes.

### Step 3: Install CUDA Libraries for faster-whisper

```bash
pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
```

**Note:** This is another ~2GB download.

### Step 4: Install Project Dependencies

```bash
pip install -r requirements.txt
```

### Step 5: Verify GPU is Working

Run this quick test:

```python
import torch
print(f"CUDA available: {torch.cuda.is_available()}")
print(f"CUDA version: {torch.version.cuda}")
print(f"GPU: {torch.cuda.get_device_name(0)}")
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
2. Verify CUDA toolkit is installed: `nvcc --version`
3. Check if your GPU supports CUDA: [NVIDIA GPU Compute Capability](https://developer.nvidia.com/cuda-gpus)

### Transcriber Falls Back to CPU

If you see "Using CPU (safer default)" in the logs but you have CUDA installed:

1. Verify PyTorch detects CUDA:
   ```python
   import torch
   print(torch.cuda.is_available())
   ```

2. If it returns `False`, reinstall PyTorch with CUDA:
   ```bash
   pip uninstall torch torchvision torchaudio
   pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
   ```

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

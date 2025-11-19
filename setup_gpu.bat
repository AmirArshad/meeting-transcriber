@echo off
REM GPU Setup Script for Meeting Transcriber
REM This script installs CUDA libraries for GPU-accelerated transcription

echo ============================================================
echo Meeting Transcriber - GPU Setup (CUDA)
echo ============================================================
echo.
echo This will install CUDA libraries for GPU acceleration.
echo Total download size: ~2-4GB
echo.
echo Prerequisites:
echo   - NVIDIA GPU (GTX 10xx series or newer)
echo   - CUDA Toolkit installed (run: nvidia-smi to check)
echo.

pause

echo.
echo [1/3] Installing PyTorch with CUDA 12.1 support...
echo.
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

if errorlevel 1 (
    echo.
    echo ERROR: PyTorch installation failed!
    echo.
    echo Trying CUDA 11.8 instead...
    pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
)

echo.
echo [2/3] Installing CUDA libraries for faster-whisper...
echo.
pip install nvidia-cublas-cu12 nvidia-cudnn-cu12

echo.
echo [3/3] Verifying CUDA setup...
echo.
python -c "import torch; print('CUDA available:', torch.cuda.is_available()); print('CUDA version:', torch.version.cuda if torch.cuda.is_available() else 'N/A'); print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'N/A')"

echo.
echo ============================================================
echo Setup complete!
echo ============================================================
echo.
echo If CUDA is available: You're ready to use GPU acceleration!
echo If CUDA is NOT available: Check SETUP_GPU.md for troubleshooting
echo.
echo Test the transcriber with:
echo   cd backend
echo   python test_transcribe.py
echo.

pause

"""
Transcription service using faster-whisper.

Provides methods for transcribing audio files to text with timestamps.
Supports all Whisper languages with English as default.
"""

import sys
import os
import contextlib
from datetime import datetime, timedelta
from inspect import Parameter, signature
from typing import Optional, List, Dict, Any
from pathlib import Path

from .base_transcriber import BaseTranscriber
from .nvidia_dll_loader import add_python_nvidia_bin_dirs_to_path


# Keep aligned with cacheContainsCompleteFasterWhisperModel in src/main-process-helpers.js (AGENTS.md).
_REQUIRED_CACHE_FILES = ("config.json", "model.bin", "tokenizer.json")
_VOCABULARY_CACHE_FILES = ("vocabulary.txt", "vocabulary.json")
_RETRYABLE_CUDA_ERROR_PATTERNS = (
    "cublas64_12.dll",
    "cublas64_13.dll",
    "cublaslt64_12.dll",
    "cublaslt64_13.dll",
    "cudnn",
    "cuda failed",
    "cuda error",
)


@contextlib.contextmanager
def hugging_face_offline_mode(enabled: bool):
    keys = ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE")
    previous = {key: os.environ.get(key) for key in keys}
    if enabled:
        for key in keys:
            os.environ[key] = "1"
    try:
        yield
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def get_hugging_face_hub_cache_dir() -> Path:
    explicit_cache = (
        os.environ.get("AVANEVIS_TRANSCRIPTION_HF_CACHE_DIR")
        or os.environ.get("HUGGINGFACE_HUB_CACHE")
        or os.environ.get("HF_HUB_CACHE")
    )
    if explicit_cache:
        return Path(explicit_cache)
    hf_home = os.environ.get("HF_HOME")
    if hf_home:
        return Path(hf_home) / "hub"
    return Path.home() / ".cache" / "huggingface" / "hub"


def get_transcription_download_lock_path(model_size: str) -> Path:
    """Return a user-private lock file path for Whisper model downloads."""
    lock_dir = get_hugging_face_hub_cache_dir().parent / ".locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    return lock_dir / f"whisper_model_{model_size}.lock"


def has_cached_faster_whisper_model(model_size: str) -> bool:
    cache_dir = get_hugging_face_hub_cache_dir()
    if not cache_dir.exists() or not cache_dir.is_dir():
        return False

    patterns = (
        f"models--Systran--faster-whisper-{model_size}",
        f"models--guillaumekln--faster-whisper-{model_size}",
    )
    for candidate in cache_dir.iterdir():
        if candidate.name not in patterns:
            continue
        snapshots_dir = candidate / "snapshots"
        if snapshots_dir.is_dir() and any(is_complete_faster_whisper_snapshot(item) for item in snapshots_dir.iterdir()):
            return True
    return False


def is_complete_faster_whisper_snapshot(snapshot_dir: Path) -> bool:
    if not snapshot_dir.is_dir():
        return False

    return all(_has_non_empty_file(snapshot_dir / filename) for filename in _REQUIRED_CACHE_FILES) and any(
        _has_non_empty_file(snapshot_dir / filename) for filename in _VOCABULARY_CACHE_FILES
    )


def _has_non_empty_file(path: Path) -> bool:
    try:
        return path.is_file() and path.stat().st_size > 0
    except OSError:
        return False


def whisper_model_supports_local_files_only(whisper_model_cls: Any) -> bool:
    try:
        parameters = signature(whisper_model_cls.__init__).parameters
    except (TypeError, ValueError, AttributeError):
        return False
    return "local_files_only" in parameters or any(parameter.kind == Parameter.VAR_KEYWORD for parameter in parameters.values())


def whisper_model_supports_download_root(whisper_model_cls: Any) -> bool:
    try:
        parameters = signature(whisper_model_cls.__init__).parameters
    except (TypeError, ValueError, AttributeError):
        return False
    return "download_root" in parameters or any(parameter.kind == Parameter.VAR_KEYWORD for parameter in parameters.values())


add_python_nvidia_bin_dirs_to_path()


class TranscriberService(BaseTranscriber):
    """
    Handles audio transcription using faster-whisper.

    Features:
    - Multiple language support (all Whisper languages)
    - Configurable model size (tiny, base, small, medium, large)
    - Markdown output with timestamps
    - Efficient GPU/CPU usage
    """

    # Supported Whisper languages
    SUPPORTED_LANGUAGES = {
        'en': 'English',
        'zh': 'Chinese',
        'de': 'German',
        'es': 'Spanish',
        'ru': 'Russian',
        'ko': 'Korean',
        'fr': 'French',
        'ja': 'Japanese',
        'pt': 'Portuguese',
        'tr': 'Turkish',
        'pl': 'Polish',
        'ca': 'Catalan',
        'nl': 'Dutch',
        'ar': 'Arabic',
        'sv': 'Swedish',
        'it': 'Italian',
        'id': 'Indonesian',
        'hi': 'Hindi',
        'fi': 'Finnish',
        'vi': 'Vietnamese',
        'he': 'Hebrew',
        'uk': 'Ukrainian',
        'el': 'Greek',
        'ms': 'Malay',
        'cs': 'Czech',
        'ro': 'Romanian',
        'da': 'Danish',
        'hu': 'Hungarian',
        'ta': 'Tamil',
        'no': 'Norwegian',
        'th': 'Thai',
        'ur': 'Urdu',
        'hr': 'Croatian',
        'bg': 'Bulgarian',
        'lt': 'Lithuanian',
        'la': 'Latin',
        'mi': 'Maori',
        'ml': 'Malayalam',
        'cy': 'Welsh',
        'sk': 'Slovak',
        'te': 'Telugu',
        'fa': 'Persian',
        'lv': 'Latvian',
        'bn': 'Bengali',
        'sr': 'Serbian',
        'az': 'Azerbaijani',
        'sl': 'Slovenian',
        'kn': 'Kannada',
        'et': 'Estonian',
        'mk': 'Macedonian',
        'br': 'Breton',
        'eu': 'Basque',
        'is': 'Icelandic',
        'hy': 'Armenian',
        'ne': 'Nepali',
        'mn': 'Mongolian',
        'bs': 'Bosnian',
        'kk': 'Kazakh',
        'sq': 'Albanian',
        'sw': 'Swahili',
        'gl': 'Galician',
        'mr': 'Marathi',
        'pa': 'Punjabi',
        'si': 'Sinhala',
        'km': 'Khmer',
        'sn': 'Shona',
        'yo': 'Yoruba',
        'so': 'Somali',
        'af': 'Afrikaans',
        'oc': 'Occitan',
        'ka': 'Georgian',
        'be': 'Belarusian',
        'tg': 'Tajik',
        'sd': 'Sindhi',
        'gu': 'Gujarati',
        'am': 'Amharic',
        'yi': 'Yiddish',
        'lo': 'Lao',
        'uz': 'Uzbek',
        'fo': 'Faroese',
        'ht': 'Haitian Creole',
        'ps': 'Pashto',
        'tk': 'Turkmen',
        'nn': 'Nynorsk',
        'mt': 'Maltese',
        'sa': 'Sanskrit',
        'lb': 'Luxembourgish',
        'my': 'Myanmar',
        'bo': 'Tibetan',
        'tl': 'Tagalog',
        'mg': 'Malagasy',
        'as': 'Assamese',
        'tt': 'Tatar',
        'haw': 'Hawaiian',
        'ln': 'Lingala',
        'ha': 'Hausa',
        'ba': 'Bashkir',
        'jw': 'Javanese',
        'su': 'Sundanese',
    }

    model: Any

    def __init__(
        self,
        model_size: str = "base",
        language: str = "en",
        device: str = "auto",
        compute_type: str = "default"
    ):
        """
        Initialize the transcriber service.

        Args:
            model_size: Whisper model size - "tiny", "base", "small", "medium", "large"
                       (base recommended for good balance of speed/accuracy)
            language: Language code (default: "en" for English)
            device: "cpu", "cuda", or "auto" (auto-detect GPU)
            compute_type: "int8", "float16", "float32", or "default" (auto-select best)
        """
        self.model_size = model_size
        self.language = language
        self.device = device
        self.compute_type = compute_type
        self.model = None

        # Validate language
        if language not in self.SUPPORTED_LANGUAGES:
            raise ValueError(
                f"Unsupported language: {language}. "
                f"Use one of: {', '.join(self.SUPPORTED_LANGUAGES.keys())}"
            )

        print(f"Initializing Whisper transcriber...", file=sys.stderr)
        print(f"  Model: {model_size}", file=sys.stderr)
        print(f"  Language: {self.SUPPORTED_LANGUAGES[language]} ({language})", file=sys.stderr)
        print(f"  Device: {device}", file=sys.stderr)

    def load_model(self):
        """Load the Whisper model. Call this once before transcribing."""
        try:
            from faster_whisper import WhisperModel  # type: ignore[import-not-found]
        except ImportError:
            raise ImportError(
                "faster-whisper not installed. Install with: pip install faster-whisper"
            )

        print(f"Loading Whisper model '{self.model_size}'...", file=sys.stderr)

        # Use file locking to prevent race conditions when multiple processes
        # try to download the model simultaneously (e.g., preload + transcription)
        import filelock  # type: ignore[import-not-found]

        lock_file = get_transcription_download_lock_path(self.model_size)
        lock = filelock.FileLock(lock_file, timeout=300)  # 5 minute timeout

        try:
            with lock:
                print(f"Acquired model download lock...", file=sys.stderr)
                self._load_model_internal()
        except filelock.Timeout:
            raise RuntimeError(
                f"Timeout waiting for model download lock after 5 minutes. "
                f"Another process may still be downloading the model, or a stale lock may need cleanup: {lock_file}"
            )

    def _load_model_internal(self):
        """Internal method to load the model (called with lock held)."""
        from faster_whisper import WhisperModel  # type: ignore[import-not-found]

        # Determine device and compute type
        device = self.device
        compute_type = self.compute_type

        # Auto-detect device if set to "auto". Use CTranslate2 directly so
        # transcription CUDA setup does not require a full PyTorch install.
        if device == "auto":
            try:
                import ctranslate2  # type: ignore[import-not-found]
                if ctranslate2.get_cuda_device_count() > 0:
                    device = "cuda"
                    print(f"CUDA detected through CTranslate2, using GPU acceleration", file=sys.stderr)
                else:
                    device = "cpu"
                    print(f"No CUDA detected, using CPU", file=sys.stderr)
            except Exception as cuda_error:
                device = "cpu"
                print(f"Using CPU (CUDA runtime check failed: {cuda_error})", file=sys.stderr)

        # Auto-detect best compute type if set to default
        if compute_type == "default":
            # Use int8 for CPU (faster), float16 for GPU (faster + accurate)
            if device == "cpu":
                compute_type = "int8"
            else:
                compute_type = "float16"

        local_files_only = self._should_use_local_files_only()
        if local_files_only:
            print("Using cached Whisper model files only.", file=sys.stderr)

        try:
            self.model = self._create_whisper_model(
                WhisperModel,
                device=device,
                compute_type=compute_type,
                local_files_only=local_files_only,
            )
            print(f"Model loaded successfully!", file=sys.stderr)
            print(f"  Device: {device.upper()}", file=sys.stderr)
            print(f"  Compute type: {compute_type}", file=sys.stderr)
            if device == "cuda":
                print(f"  Using GPU acceleration - transcription will be 4-5x faster!", file=sys.stderr)
        except Exception as e:
            # If GPU fails (missing CUDA libraries), fall back to CPU
            if device != "cpu":
                error_msg = str(e).lower()

                # Provide specific guidance based on error
                print(f"\n⚠ GPU initialization failed, falling back to CPU...", file=sys.stderr)
                print(f"  Error: {e}", file=sys.stderr)
                print(f"", file=sys.stderr)

                if "cudnn" in error_msg or "cublas" in error_msg:
                    print(f"  Missing CUDA libraries detected!", file=sys.stderr)
                    print(f"  To enable GPU acceleration, install:", file=sys.stderr)
                    print(f"    pip install nvidia-cublas-cu12 nvidia-cudnn-cu12", file=sys.stderr)
                    print(f"", file=sys.stderr)
                    print(f"  See SETUP_GPU.md for detailed instructions.", file=sys.stderr)
                elif "cuda" in error_msg:
                    print(f"  CUDA not available or misconfigured.", file=sys.stderr)
                    print(f"  To enable GPU acceleration:", file=sys.stderr)
                    print(f"    pip install nvidia-cublas-cu12 nvidia-cudnn-cu12", file=sys.stderr)
                    print(f"", file=sys.stderr)
                    print(f"  See SETUP_GPU.md for detailed instructions.", file=sys.stderr)

                print(f"", file=sys.stderr)
                print(f"  Continuing with CPU (slower but still works)...", file=sys.stderr)
                print(f"", file=sys.stderr)

                device = "cpu"
                compute_type = "int8"
                self.model = self._create_whisper_model(
                    WhisperModel,
                    device=device,
                    compute_type=compute_type,
                    local_files_only=local_files_only,
                )
                print(f"Model loaded successfully on CPU!", file=sys.stderr)
                print(f"  Note: CPU is 4-5x slower than GPU. Consider setting up CUDA for faster transcription.", file=sys.stderr)
            else:
                raise

    def _should_use_local_files_only(self) -> bool:
        explicit = os.environ.get("AVANEVIS_TRANSCRIPTION_LOCAL_FILES_ONLY", "").strip().lower()
        if explicit in {"1", "true", "yes"}:
            return True
        if explicit in {"0", "false", "no"}:
            return False
        return has_cached_faster_whisper_model(self.model_size)

    def _create_whisper_model(self, whisper_model_cls: Any, *, device: str, compute_type: str, local_files_only: bool) -> Any:
        kwargs = {
            "device": device,
            "compute_type": compute_type,
        }
        if whisper_model_supports_local_files_only(whisper_model_cls):
            kwargs["local_files_only"] = local_files_only
        if whisper_model_supports_download_root(whisper_model_cls):
            kwargs["download_root"] = str(get_hugging_face_hub_cache_dir())

        with hugging_face_offline_mode(local_files_only):
            return whisper_model_cls(self.model_size, **kwargs)

    @staticmethod
    def _is_retryable_cuda_runtime_error(error: Exception) -> bool:
        message = str(error or "").lower()
        return any(pattern in message for pattern in _RETRYABLE_CUDA_ERROR_PATTERNS)

    def _run_transcription_attempt(self, audio_path: str) -> Dict[str, Any]:
        segments, info = self.model.transcribe(
            audio_path,
            language=self.language,
            beam_size=5,  # Good balance of accuracy and speed
            vad_filter=True,  # Voice activity detection - removes silence
            vad_parameters=dict(min_silence_duration_ms=500)  # Remove pauses > 500ms
        )

        segments_list = []
        full_text = []

        print(f"Processing segments...", file=sys.stderr)
        for segment in segments:
            segments_list.append({
                'start': segment.start,
                'end': segment.end,
                'text': segment.text.strip()
            })
            full_text.append(segment.text.strip())

        # Merge segments into larger chunks for better readability
        # Target: ~20 seconds per chunk (good for long meetings)
        print(f"Merging {len(segments_list)} segments into larger chunks...", file=sys.stderr)
        segments_list = self._merge_segments(segments_list, target_duration=20.0)

        return {
            'text': ' '.join(full_text),
            'segments': segments_list,
            'language': info.language,
            'duration': info.duration,
            'output_file': None,
        }

    def transcribe_file(
        self,
        audio_path: str,
        output_path: Optional[str] = None,
        save_markdown: bool = True
    ) -> Dict[str, Any]:
        """
        Transcribe an audio file to text.

        Args:
            audio_path: Path to audio file (.wav, .mp3, etc.)
            output_path: Optional path for output markdown file
                        (defaults to same name as audio with .md extension)
            save_markdown: Whether to save the transcript to a markdown file

        Returns:
            Dictionary with transcription results:
            {
                'text': 'full transcript text',
                'segments': [list of segment dicts with text and timestamps],
                'language': 'detected language code',
                'duration': duration in seconds,
                'output_file': path to saved markdown file (if saved)
            }
        """
        if self.model is None:
            raise RuntimeError("Model not loaded. Call load_model() first.")

        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        print(f"\nTranscribing: {audio_path}", file=sys.stderr)
        print(f"Language: {self.SUPPORTED_LANGUAGES[self.language]} ({self.language})", file=sys.stderr)

        retry_device = self.device in {"auto", "cuda"}
        try:
            results = self._run_transcription_attempt(audio_path)
        except Exception as error:
            if not retry_device or not self._is_retryable_cuda_runtime_error(error):
                raise

            print(
                "CUDA transcription failed because required runtime libraries could not be loaded.",
                file=sys.stderr,
            )
            print(
                "Retrying transcription on CPU. This may take significantly longer.",
                file=sys.stderr,
            )

            self.cleanup()
            self.device = "cpu"
            self.compute_type = "int8"
            self.load_model()
            results = self._run_transcription_attempt(audio_path)

        print(f"Transcription complete!", file=sys.stderr)
        print(f"  Detected language: {results['language']}", file=sys.stderr)
        print(f"  Duration: {results['duration']:.2f} seconds", file=sys.stderr)
        print(f"  Segments: {len(results['segments'])}", file=sys.stderr)

        # Save to markdown if requested
        if save_markdown:
            if output_path is None:
                # Default: same name as audio file with .md extension
                audio_file = Path(audio_path)
                output_path = str(audio_file.with_suffix('.md'))

            self._save_markdown(results, audio_path, output_path)
            results['output_file'] = output_path

        # Add audio path to results for meeting manager
        results['audioPath'] = str(audio_path)

        return results

    def _merge_segments(
        self,
        segments: List[Dict[str, Any]],
        target_duration: float = 20.0
    ) -> List[Dict[str, Any]]:
        """
        Merge consecutive segments into larger chunks for better readability.

        Args:
            segments: List of segment dicts with 'start', 'end', 'text'
            target_duration: Target duration in seconds for each merged chunk (default: 20s)

        Returns:
            List of merged segments
        """
        if not segments:
            return []

        merged = []
        current_chunk = None

        for segment in segments:
            if current_chunk is None:
                # Start new chunk
                current_chunk = {
                    'start': segment['start'],
                    'end': segment['end'],
                    'text': segment['text']
                }
            else:
                chunk_duration = current_chunk['end'] - current_chunk['start']

                # If adding this segment would exceed target duration, save current chunk
                if chunk_duration >= target_duration:
                    merged.append(current_chunk)
                    current_chunk = {
                        'start': segment['start'],
                        'end': segment['end'],
                        'text': segment['text']
                    }
                else:
                    # Merge into current chunk
                    current_chunk['end'] = segment['end']
                    current_chunk['text'] += ' ' + segment['text']

        # Don't forget the last chunk
        if current_chunk is not None:
            merged.append(current_chunk)

        print(f"  Merged into {len(merged)} chunks (target: {target_duration}s each)", file=sys.stderr)
        return merged

    def _save_markdown(
        self,
        results: Dict[str, Any],
        audio_path: str,
        output_path: str
    ):
        """Save transcription results to a markdown file with timestamps."""
        audio_file = Path(audio_path)

        # Format duration
        duration = timedelta(seconds=int(results['duration']))

        # Build markdown content
        lines = [
            "# Meeting Transcription",
            "",
            f"**File:** {audio_file.name}",
            f"**Date:** {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            f"**Duration:** {duration}",
            f"**Language:** {self.SUPPORTED_LANGUAGES.get(results['language'], results['language'])}",
            "",
            "---",
            "",
            "## Transcript",
            ""
        ]

        # Add segments with timestamps
        for segment in results['segments']:
            start_time = self._format_timestamp(segment['start'])
            end_time = self._format_timestamp(segment['end'])
            text = segment['text']

            lines.append(f"**[{start_time} - {end_time}]**  ")
            lines.append(f"{text}")
            lines.append("")

        # Write to file
        markdown_content = '\n'.join(lines)

        with open(output_path, 'w', encoding='utf-8') as f:
            f.write(markdown_content)

        print(f"\nTranscript saved to: {output_path}", file=sys.stderr)

    def _format_timestamp(self, seconds: float) -> str:
        """Format seconds as HH:MM:SS timestamp."""
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)

        if hours > 0:
            return f"{hours:02d}:{minutes:02d}:{secs:02d}"
        else:
            return f"{minutes:02d}:{secs:02d}"

    def cleanup(self):
        """Clean up resources."""
        if self.model is not None:
            # faster-whisper handles cleanup automatically
            self.model = None
            print("Transcriber cleaned up", file=sys.stderr)

    def get_model_info(self) -> Dict[str, Any]:
        """Return metadata about the configured model/runtime."""
        return {
            'backend': 'faster-whisper',
            'model_size': self.model_size,
            'language': self.language,
            'device': self.device,
            'compute_type': self.compute_type,
            'loaded': self.model is not None,
        }


# CLI interface
def main():
    """
    CLI for the transcriber service.
    """
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="AvaNevis CLI")
    parser.add_argument("audio_file", nargs="?", help="Path to audio file")
    parser.add_argument("--file", dest="file_arg", help="Path to audio file (alternative)")
    parser.add_argument("--language", default="en", help="Language code (default: en)")
    parser.add_argument("--model", default="base", help="Model size (default: base)")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"], help="Inference device (default: auto)")
    parser.add_argument("--json", action="store_true", help="Output results as JSON")
    parser.add_argument("--preload", action="store_true", help="Preload model and exit (for warming up)")

    args = parser.parse_args()

    # Handle preload mode - just load model and exit
    if args.preload:
        try:
            print(f"Preloading {args.model} model...", file=sys.stderr)
            transcriber = TranscriberService(
                model_size=args.model,
                language=args.language,
                device=args.device
            )
            transcriber.load_model()
            print(f"Model preloaded successfully!", file=sys.stderr)
            transcriber.cleanup()
            sys.exit(0)
        except Exception as e:
            print(f"Failed to preload model: {e}", file=sys.stderr)
            sys.exit(1)

    # Handle file argument (positional or flag)
    audio_file = args.audio_file or args.file_arg

    if not audio_file:
        parser.print_help()
        sys.exit(1)

    # Create transcriber
    transcriber = None

    try:
        transcriber = TranscriberService(
            model_size=args.model,
            language=args.language,
            device=args.device
        )
        
        # Load model
        transcriber.load_model()

        # Transcribe
        results = transcriber.transcribe_file(audio_file)

        if args.json:
            # Output JSON to stdout for integration
            # Keep ensure_ascii=True (default) to avoid encoding issues on Windows
            # Unicode will be escaped as \uXXXX which JSON.parse handles correctly
            try:
                json_output = json.dumps(results, indent=2)
                print(json_output)
                sys.stdout.flush()  # Ensure output is sent immediately
                sys.exit(0)  # Explicitly exit with success code
            except Exception as json_error:
                print(f"\nERROR serializing JSON: {json_error}", file=sys.stderr)
                print(f"Results type: {type(results)}", file=sys.stderr)
                print(f"Results keys: {results.keys()}", file=sys.stderr)
                raise
        else:
            # Human-readable output
            print("\n" + "=" * 60)
            print("TRANSCRIPTION COMPLETE")
            print("=" * 60)
            print(f"\nFull text:\n{results['text']}")
            print(f"\nMarkdown saved to: {results['output_file']}")
            sys.exit(0)  # Explicitly exit with success code

    except Exception as e:
        # Print error to stderr so it doesn't corrupt JSON output
        print(f"\nERROR: {e}", file=sys.stderr)
        # Always print traceback to stderr for debugging
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
    finally:
        if transcriber is not None:
            try:
                transcriber.cleanup()
            except Exception as cleanup_error:
                # Don't fail the whole script if cleanup fails
                print(f"Warning: Cleanup error (non-fatal): {cleanup_error}", file=sys.stderr)


if __name__ == "__main__":
    main()

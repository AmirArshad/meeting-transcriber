"""
Transcription service using Lightning-Whisper-MLX for Apple Silicon.

Provides methods for transcribing audio files to text with timestamps.
Optimized for Apple M-series chips using the MLX framework with Metal GPU acceleration.
"""

import sys
import os
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any, Tuple
from pathlib import Path

from .base_transcriber import BaseTranscriber


class MLXWhisperTranscriber(BaseTranscriber):
    """
    Handles audio transcription using Lightning-Whisper-MLX on Apple Silicon.

    Features:
    - Multiple language support (all Whisper languages)
    - Configurable model size (tiny, base, small, medium, large)
    - Markdown output with timestamps
    - Metal GPU acceleration via MLX framework
    - Optimized for Apple M1/M2/M3/M4 chips
    """

    MODEL_SPECS = {
        "tiny": {
            "model_key": "tiny",
            "repo_id": "mlx-community/whisper-tiny-mlx",
            "storage_dir": "whisper-tiny-mlx",
        },
        "base": {
            "model_key": "base",
            "repo_id": "mlx-community/whisper-base-mlx",
            "storage_dir": "whisper-base-mlx",
        },
        "small": {
            "model_key": "distil-small.en",
            "repo_id": "mustafaaljadery/distil-whisper-mlx",
            "storage_dir": "distil-small.en",
            "distil": True,
        },
        "medium": {
            "model_key": "distil-medium.en",
            "repo_id": "mustafaaljadery/distil-whisper-mlx",
            "storage_dir": "distil-medium.en",
            "distil": True,
        },
        "large": {
            "model_key": "distil-large-v3",
            "repo_id": "mustafaaljadery/distil-whisper-mlx",
            "storage_dir": "distil-large-v3",
            "distil": True,
        },
        "large-v3": {
            "model_key": "distil-large-v3",
            "repo_id": "mustafaaljadery/distil-whisper-mlx",
            "storage_dir": "distil-large-v3",
            "distil": True,
        },
    }

    MULTILINGUAL_MODEL_SPECS = {
        "tiny": {
            "model_key": "tiny",
            "repo_id": "mlx-community/whisper-tiny-mlx",
            "storage_dir": "whisper-tiny-mlx",
        },
        "base": {
            "model_key": "base",
            "repo_id": "mlx-community/whisper-base-mlx",
            "storage_dir": "whisper-base-mlx",
        },
        "small": {
            "model_key": "small",
            "repo_id": "mlx-community/whisper-small-mlx",
            "storage_dir": "whisper-small-mlx",
        },
        "medium": {
            "model_key": "medium",
            "repo_id": "mlx-community/whisper-medium-mlx",
            "storage_dir": "whisper-medium-mlx",
        },
        "large": {
            "model_key": "large-v3",
            "repo_id": "mlx-community/whisper-large-v3-mlx",
            "storage_dir": "whisper-large-v3-mlx",
        },
        "large-v3": {
            "model_key": "large-v3",
            "repo_id": "mlx-community/whisper-large-v3-mlx",
            "storage_dir": "whisper-large-v3-mlx",
        },
    }

    model: Any
    model_ready: bool
    cache_dir: Path
    model_key: str
    model_repo: str
    model_storage_dir: str
    model_dir: Path

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

    def __init__(
        self,
        model_size: str = "base",
        language: str = "en",
        device: str = "auto",
        compute_type: str = "default"
    ):
        """
        Initialize the MLX Whisper transcriber.

        Args:
            model_size: Whisper model size - "tiny", "base", "small", "medium", "large-v3"
                       (base recommended for good balance of speed/accuracy)
            language: Language code (default: "en" for English)
            device: Ignored for MLX (always uses Metal GPU), kept for API compatibility
            compute_type: Ignored for MLX (always uses float16), kept for API compatibility
        """
        self.model_size = model_size
        self.language = language
        self.device = "metal"  # MLX uses Metal GPU
        self.compute_type = "float16"  # MLX uses float16
        self.model = None
        self.model_ready = False  # Flag indicating model is ready for transcription
        self.cache_dir = self._get_cache_dir()
        self.model_key, self.model_repo, self.model_storage_dir = self._resolve_model_spec(model_size)
        self.model_dir = self.cache_dir / 'mlx_models' / self.model_storage_dir

        # Validate language
        if language not in self.SUPPORTED_LANGUAGES:
            raise ValueError(
                f"Unsupported language: {language}. "
                f"Use one of: {', '.join(self.SUPPORTED_LANGUAGES.keys())}"
            )

        print(f"Initializing MLX Whisper transcriber (Apple Silicon)...", file=sys.stderr)
        print(f"  Model: {model_size}", file=sys.stderr)
        print(f"  Language: {self.SUPPORTED_LANGUAGES[language]} ({language})", file=sys.stderr)
        print(f"  Device: Metal GPU (Apple Silicon)", file=sys.stderr)

    def _resolve_model_spec(self, model_size: str) -> Tuple[str, str, str]:
        """Resolve the backend model key, download repo, and storage directory."""
        specs = self.MODEL_SPECS if self.language == 'en' else self.MULTILINGUAL_MODEL_SPECS
        spec = specs.get(model_size, specs['base'])
        return spec['model_key'], spec['repo_id'], spec['storage_dir']

    def _get_cache_dir(self) -> Path:
        """Return the writable cache directory used for MLX model downloads."""
        if sys.platform == 'darwin':
            return Path.home() / 'Library' / 'Caches' / 'meeting-transcriber'
        return Path.home() / '.cache' / 'meeting-transcriber'

    def _download_model_files(self) -> None:
        """Download model files into the app-managed cache directory."""
        from huggingface_hub import hf_hub_download  # type: ignore[import-not-found]

        self.model_dir.mkdir(parents=True, exist_ok=True)

        if self.language == 'en' and self.model_key.startswith('distil-'):
            filenames = [
                f'./mlx_models/{self.model_storage_dir}/weights.npz',
                f'./mlx_models/{self.model_storage_dir}/config.json',
            ]
            local_dir = str(self.cache_dir)
        else:
            filenames = ['weights.npz', 'config.json']
            local_dir = str(self.model_dir)

        for filename in filenames:
            hf_hub_download(
                repo_id=self.model_repo,
                filename=filename,
                local_dir=local_dir,
            )

    def _transcribe_audio(self, audio_path: str) -> Dict[str, Any]:
        """Run MLX transcription against the prepared local model directory."""
        from lightning_whisper_mlx.transcribe import transcribe_audio  # type: ignore[import-not-found]

        return transcribe_audio(
            audio_path,
            path_or_hf_repo=str(self.model_dir),
            language=self.language,
            batch_size=12,
        )

    def load_model(self):
        """Load the Whisper model via MLX. Call this once before transcribing."""
        try:
            import lightning_whisper_mlx  # noqa: F401  # type: ignore[import-not-found]
            import huggingface_hub  # noqa: F401  # type: ignore[import-not-found]
        except ImportError:
            raise ImportError(
                "lightning-whisper-mlx not installed. Install with: pip install lightning-whisper-mlx"
            )

        print(f"Loading MLX Whisper model '{self.model_size}'...", file=sys.stderr)

        # Use file locking to prevent race conditions when multiple processes
        # try to download the model simultaneously (e.g., preload + transcription)
        import tempfile
        import filelock  # type: ignore[import-not-found]

        lock_file = Path(tempfile.gettempdir()) / f"whisper_mlx_model_{self.model_size}.lock"
        lock = filelock.FileLock(lock_file, timeout=1200)  # 20 minute timeout for large model downloads

        try:
            with lock:
                print(f"Acquired model download lock...", file=sys.stderr)
                self._load_model_internal()
        except filelock.Timeout:
            raise RuntimeError(
                f"Timeout waiting for model download lock after 20 minutes. "
                f"Another process may be downloading the model, or a previous download may have failed. "
                f"Try deleting the lock file: {lock_file}"
            )

    def _load_model_internal(self):
        """Internal method to load the model (called with lock held)."""
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        print(f"Using model cache directory: {self.cache_dir}", file=sys.stderr)

        try:
            print(f"Verifying/Downloading model: {self.model_repo}...", file=sys.stderr)
            self._download_model_files()
            self.model = {
                'model_key': self.model_key,
                'model_dir': str(self.model_dir),
            }

            self.model_ready = True

            print(f"Model ready!", file=sys.stderr)
            print(f"  Backend: Lightning-Whisper-MLX", file=sys.stderr)
            print(f"  Device: Metal GPU", file=sys.stderr)
            print(f"  Compute type: float16", file=sys.stderr)
            print(f"  Using Apple Silicon GPU acceleration - optimized for M-series chips!", file=sys.stderr)

        except Exception as mlx_error:
            print(f"\n❌ MLX model initialization failed: {mlx_error}", file=sys.stderr)
            print(f"", file=sys.stderr)
            print(f"This app requires Apple Silicon (M1/M2/M3/M4) for transcription.", file=sys.stderr)
            print(f"", file=sys.stderr)
            print(f"Troubleshooting:", file=sys.stderr)
            print(f"  1. Make sure you're running on an Apple Silicon Mac", file=sys.stderr)
            print(f"  2. Try reinstalling: pip install lightning-whisper-mlx mlx", file=sys.stderr)
            print(f"  3. Check that MLX is working: python -c 'import mlx'", file=sys.stderr)
            print(f"", file=sys.stderr)
            raise RuntimeError(f"Failed to load MLX transcription model: {mlx_error}")

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
        if not self.model_ready:
            raise RuntimeError("Model not loaded. Call load_model() first.")

        if not os.path.exists(audio_path):
            raise FileNotFoundError(f"Audio file not found: {audio_path}")

        print(f"\nTranscribing: {audio_path}", file=sys.stderr)
        print(f"Language: {self.SUPPORTED_LANGUAGES[self.language]} ({self.language})", file=sys.stderr)

        # Transcribe using Lightning-Whisper-MLX
        detected_language = self.language  # Default fallback
        segments_list = []
        full_text = []

        print(f"Transcribing with Lightning-Whisper-MLX...", file=sys.stderr)

        result = self._transcribe_audio(audio_path)

        print(f"Processing result...", file=sys.stderr)

        # Handle the result - lightning-whisper-mlx returns dict with 'text'
        # and optionally 'segments'
        if isinstance(result, dict):
            if 'segments' in result and result['segments']:
                for segment in result['segments']:
                    segments_list.append({
                        'start': segment.get('start', 0),
                        'end': segment.get('end', 0),
                        'text': segment.get('text', '').strip()
                    })
                    full_text.append(segment.get('text', '').strip())
            elif 'text' in result:
                # No segments, just full text - create a single segment
                text = result['text'].strip()
                full_text.append(text)
                segments_list.append({
                    'start': 0,
                    'end': 0,  # Duration unknown without segments
                    'text': text
                })

            # Get detected language from result if available
            detected_language = result.get('language', self.language)
        else:
            # Unexpected result format
            print(f"WARNING: Unexpected result format: {type(result)}", file=sys.stderr)
            full_text.append(str(result))
            segments_list.append({'start': 0, 'end': 0, 'text': str(result)})

        # Get audio duration (calculate from last segment if available)
        duration = segments_list[-1]['end'] if segments_list else 0.0
        if duration <= 0:
            duration = self._probe_audio_duration(audio_path)

        # Merge segments into larger chunks for better readability
        # Target: ~20 seconds per chunk (good for long meetings)
        print(f"Merging {len(segments_list)} segments into larger chunks...", file=sys.stderr)
        segments_list = self._merge_segments(segments_list, target_duration=20.0)

        # Prepare results
        results = {
            'text': ' '.join(full_text),
            'segments': segments_list,
            'language': detected_language,
            'duration': duration,
            'output_file': None
        }

        print(f"Transcription complete!", file=sys.stderr)
        print(f"  Detected language: {results['language']}", file=sys.stderr)
        print(f"  Duration: {duration:.2f} seconds", file=sys.stderr)
        print(f"  Segments: {len(segments_list)}", file=sys.stderr)

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
            f"**Transcribed with:** Lightning-Whisper-MLX (Apple Silicon)",
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
        if self.model_ready:
            # MLX handles cleanup automatically
            self.model = None
            self.model_ready = False
            print("MLX Transcriber cleaned up", file=sys.stderr)

    def get_model_info(self) -> Dict[str, Any]:
        """Return metadata about the configured model/runtime."""
        return {
            'backend': 'lightning-whisper-mlx',
            'model_size': self.model_size,
            'language': self.language,
            'device': self.device,
            'compute_type': self.compute_type,
            'model_key': self.model_key,
            'model_repo': self.model_repo,
            'cache_dir': str(self.cache_dir),
            'model_dir': str(self.model_dir),
            'loaded': self.model_ready,
        }

    def _probe_audio_duration(self, audio_path: str) -> float:
        """Best-effort duration probe when the backend returns no timestamps."""
        try:
            import wave

            with wave.open(audio_path, 'rb') as wav_file:
                frame_rate = wav_file.getframerate()
                if frame_rate:
                    return wav_file.getnframes() / float(frame_rate)
        except Exception:
            pass

        try:
            import subprocess
            result = subprocess.run(
                [
                    'ffprobe',
                    '-v', 'error',
                    '-show_entries', 'format=duration',
                    '-of', 'default=noprint_wrappers=1:nokey=1',
                    audio_path,
                ],
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            if result.returncode == 0 and result.stdout.strip():
                return float(result.stdout.strip())
        except Exception:
            pass

        return 0.0


# Backwards compatibility alias
TranscriberService = MLXWhisperTranscriber


# CLI interface
def main():
    """
    CLI for the MLX transcriber service.
    """
    import argparse
    import json
    import sys

    parser = argparse.ArgumentParser(description="Meeting Transcriber CLI (MLX/Apple Silicon)")
    parser.add_argument("audio_file", nargs="?", help="Path to audio file")
    parser.add_argument("--file", dest="file_arg", help="Path to audio file (alternative)")
    parser.add_argument("--language", default="en", help="Language code (default: en)")
    parser.add_argument("--model", default="base", help="Model size (default: base)")
    parser.add_argument("--json", action="store_true", help="Output results as JSON")
    parser.add_argument("--preload", action="store_true", help="Preload model and exit (for warming up)")

    args = parser.parse_args()

    # Handle preload mode - just load model and exit
    if args.preload:
        try:
            print(f"Preloading {args.model} model (MLX)...", file=sys.stderr)
            transcriber = MLXWhisperTranscriber(
                model_size=args.model,
                language=args.language
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
        transcriber = MLXWhisperTranscriber(
            model_size=args.model,
            language=args.language
        )

        # Load model
        transcriber.load_model()

        # Transcribe
        results = transcriber.transcribe_file(audio_file)

        if args.json:
            # Output JSON to stdout for integration
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

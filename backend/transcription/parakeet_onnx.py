"""Pinned onnx-asr Parakeet CUDA adapter over bounded PCM windows."""
from __future__ import annotations

from .parakeet_segments import InvalidParakeetOutput, token_words


class CudaParakeet:
    device = 'cuda'

    def __init__(self, model_dir: str, vad_dir: str = ''):
        self.model_dir = model_dir
        self.vad_dir = vad_dir
        self.model = None

    @staticmethod
    def _sessions(value, seen=None):
        seen = set() if seen is None else seen
        if id(value) in seen:
            return []
        seen.add(id(value))
        if hasattr(value, 'get_providers') and hasattr(value, 'run'):
            return [value]
        sessions = []
        for name in ('asr', 'vad', 'encoder', 'decoder', 'encoder_session',
                     'decoder_session', 'session', 'model', '_model', '_encoder',
                     '_decoder_joint'):
            child = getattr(value, name, None)
            if child is not None:
                sessions.extend(CudaParakeet._sessions(child, seen))
        return sessions

    def load_model(self):
        import onnx_asr
        import onnxruntime as ort
        if 'CUDAExecutionProvider' not in ort.get_available_providers():
            raise RuntimeError('PARAKEET_GPU_UNAVAILABLE')
        vad = onnx_asr.load_vad('silero', path=self.vad_dir,
                                providers=['CUDAExecutionProvider'])
        model = onnx_asr.load_model('nemo-parakeet-tdt-0.6b-v2', path=self.model_dir,
                                    providers=['CUDAExecutionProvider'])
        model = model.with_vad(vad, batch_size=1, threshold=.5, neg_threshold=.35,
                               min_speech_duration_ms=250, min_silence_duration_ms=500,
                               max_speech_duration_s=20, speech_pad_ms=30).with_timestamps()
        sessions = self._sessions(model)
        if len(sessions) < 3 or any(session.get_providers()[0] != 'CUDAExecutionProvider'
                                    for session in sessions):
            raise RuntimeError('PARAKEET_GPU_UNAVAILABLE')
        for session in sessions:
            session.disable_fallback()
        self.model = model

    def transcribe_window(self, pcm: bytes, *, input_start: float, input_end: float):
        if self.model is None:
            raise RuntimeError('Parakeet model is not loaded.')
        import numpy as np
        if len(pcm) % 2:
            raise InvalidParakeetOutput('Invalid PCM length.')
        audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
        if len(audio) == 0:
            return []
        words = []
        for segment in self.model.recognize(audio, sample_rate=16000):
            tokens = getattr(segment, 'tokens', None)
            starts = getattr(segment, 'timestamps', None)
            if tokens is None or starts is None or len(tokens) != len(starts):
                raise InvalidParakeetOutput('ONNX tokens and timestamps differ.')
            words.extend(token_words([{'text': text, 'start': start}
                                      for text, start in zip(tokens, starts)],
                                     input_start=input_start, input_end=input_end,
                                     segment_start=float(segment.start),
                                     segment_end=float(segment.end), starts_only=True))
        return words

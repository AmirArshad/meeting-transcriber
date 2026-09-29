"""Local-only Parakeet MLX adapter; no hub resolver or long-file merge path."""
from __future__ import annotations

import json
from pathlib import Path

from .parakeet_segments import InvalidParakeetOutput, token_words


class MetalParakeet:
    device = 'metal'

    def __init__(self, model_dir: str):
        self.model_dir = Path(model_dir)
        self.model = None
        self.mx = None

    def load_model(self):
        config_path = self.model_dir / 'config.json'
        weights_path = self.model_dir / 'model.safetensors'
        if not config_path.is_file() or not weights_path.is_file():
            raise FileNotFoundError('PARAKEET_ARTIFACT_INVALID')
        import mlx.core as mx
        from mlx.utils import tree_flatten, tree_unflatten
        from parakeet_mlx.utils import from_config
        if not mx.metal.is_available():
            raise RuntimeError('PARAKEET_GPU_UNAVAILABLE')
        mx.set_default_device(mx.gpu)
        probe = mx.ones((2, 2), dtype=mx.float32).sum()
        mx.eval(probe)
        if float(probe) != 4.0:
            raise RuntimeError('PARAKEET_GPU_UNAVAILABLE')
        with config_path.open(encoding='utf-8') as source:
            config = json.load(source)
        model = from_config(config)
        model.load_weights(str(weights_path))
        model.update(tree_unflatten([(key, value.astype(mx.float32))
                                     for key, value in tree_flatten(model.parameters())]))
        mx.eval(*[value for _, value in tree_flatten(model.parameters())])
        self.mx = mx
        self.model = model

    def transcribe_window(self, pcm: bytes, *, input_start: float, input_end: float):
        if self.model is None:
            raise RuntimeError('Parakeet model is not loaded.')
        import numpy as np
        from parakeet_mlx.audio import get_logmel
        from parakeet_mlx.parakeet import DecodingConfig, Greedy
        if len(pcm) % 2:
            raise InvalidParakeetOutput('Invalid PCM length.')
        samples = np.frombuffer(pcm, dtype='<i2')
        if len(samples) < self.model.preprocessor_config.hop_length:
            return []
        mx = self.mx
        audio = mx.array(samples).astype(mx.float32) / 32768.0
        mel = get_logmel(audio, self.model.preprocessor_config)
        result = self.model.generate(mel, decoding_config=DecodingConfig(decoding=Greedy()))[0]
        mx.eval(mel)
        tokens = getattr(result, 'tokens', None)
        if tokens is None:
            raise InvalidParakeetOutput('Aligned tokens are missing.')
        return token_words([{'text': token.text, 'start': token.start,
                             'duration': token.duration} for token in tokens],
                           input_start=input_start, input_end=input_end)

"""Bounded Parakeet windows and strict source-relative word assembly."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

SAMPLE_RATE = 16000
OWNERSHIP_SECONDS = 18.0
CONTEXT_SECONDS = 0.35
BOUNDARY_POLICY = 'parakeet-boundaries-v1'


class InvalidParakeetOutput(ValueError):
    code = 'PARAKEET_INVALID_OUTPUT'


@dataclass(frozen=True)
class Window:
    ownership_start: float
    ownership_end: float
    input_start: float
    input_end: float
    final: bool


def windows(duration: float):
    if not math.isfinite(duration) or duration < 0:
        raise InvalidParakeetOutput('Invalid source duration.')
    count = math.ceil(duration / OWNERSHIP_SECONDS)
    for index in range(count):
        start = index * OWNERSHIP_SECONDS
        end = min(duration, start + OWNERSHIP_SECONDS)
        yield Window(start, end, max(0.0, start - CONTEXT_SECONDS),
                     min(duration, end + CONTEXT_SECONDS), index == count - 1)


def _time(value: object, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise InvalidParakeetOutput('Invalid token timestamp.') from exc
    if not math.isfinite(number) or number < low - .08 or number > high + .08:
        raise InvalidParakeetOutput('Token timestamp exceeds its audio bounds.')
    return min(high, max(low, number))


def token_words(tokens: list[dict], *, input_start: float, input_end: float,
                segment_start: float = 0.0, segment_end: float | None = None,
                starts_only: bool = False) -> list[dict]:
    """Normalize aligned tokens, applying the outer/VAD offsets exactly once."""
    if not isinstance(tokens, list):
        raise InvalidParakeetOutput('Token array is missing.')
    local_end = input_end - input_start
    vad_end = local_end if segment_end is None else segment_end
    if not 0 <= segment_start <= vad_end <= local_end + .08:
        raise InvalidParakeetOutput('Invalid VAD interval.')
    words = []
    current = None
    previous = -math.inf
    for token in tokens:
        if not isinstance(token, dict) or not isinstance(token.get('text'), str):
            raise InvalidParakeetOutput('Invalid aligned token.')
        piece = token['text']
        local_start = _time(token.get('start'), 0, vad_end - segment_start)
        if local_start < previous - 1e-5:
            raise InvalidParakeetOutput('Token timestamps are reversed.')
        previous = local_start
        absolute_start = _time(input_start + segment_start + local_start, input_start, input_end)
        if starts_only:
            absolute_end = absolute_start
        else:
            duration = _time(token.get('duration'), 0, vad_end - segment_start)
            absolute_end = _time(absolute_start + duration, absolute_start, input_end)
        if not piece.strip():
            continue
        if current is None or piece[:1].isspace():
            current = {'start': absolute_start, 'end': absolute_end,
                       'text': piece.strip(), 'estimated': starts_only}
            words.append(current)
        else:
            current['text'] += piece
            current['end'] = absolute_end
    if starts_only:
        end = _time(input_start + vad_end, input_start, input_end)
        for index, word in enumerate(words):
            following = next((item['start'] for item in words[index + 1:]
                              if item['start'] > word['start']), end)
            word['end'] = max(word['start'], min(end, following))
    return words


def retain_owned(words: list[dict], window: Window) -> list[dict]:
    return [word for word in words if window.ownership_start <= word['start']
            and (word['start'] < window.ownership_end
                 or (window.final and word['start'] == window.ownership_end))]


def _key(word: dict) -> str:
    return re.sub(r'[^\w]+', '', word['text'].casefold())


def repair_seam(previous: list[dict], following: list[dict], seam: float) -> list[dict]:
    left = [w for w in previous[-8:] if abs(w['start'] - seam) <= .75]
    right = [w for w in following[:8] if abs(w['start'] - seam) <= .75]
    longest = 0
    for length in range(2, min(len(left), len(right)) + 1):
        if all(_key(a) and _key(a) == _key(b)
               and abs(a['start'] - b['start']) <= .5
               and a.get('speaker') == b.get('speaker')
               for a, b in zip(left[-length:], right[:length])):
            longest = length
    return following[longest:]


def assemble(words: list[dict], duration: float) -> list[dict]:
    result = []
    current = None
    previous = -math.inf
    for word in words:
        start = _time(word.get('start'), 0, duration)
        end = _time(word.get('end'), start, duration)
        if start < previous - 1e-5:
            raise InvalidParakeetOutput('Words are out of order.')
        previous = start
        text = word.get('text')
        if not isinstance(text, str) or not text.strip():
            raise InvalidParakeetOutput('Empty aligned word.')
        speaker = word.get('speaker')
        if current and (current.get('speaker') != speaker
                        or start - current['end'] >= 1
                        or end - current['start'] > 20):
            result.append(current)
            current = None
        if current is None:
            current = {'start': start, 'end': end, 'text': text.strip()}
            if speaker:
                current['speaker'] = speaker
        else:
            current['end'] = max(current['end'], end)
            current['text'] += ' ' + text.strip()
        if re.search(r'[.!?]$', text.strip()):
            result.append(current)
            current = None
    if current:
        result.append(current)
    return result

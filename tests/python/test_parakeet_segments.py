import math

import pytest

from backend.transcription.parakeet_segments import (
    InvalidParakeetOutput, assemble, repair_seam, retain_owned, token_words, windows,
)


def test_windows_bounded_and_final_partial():
    parts = list(windows(39.2))
    assert [(p.ownership_start, p.ownership_end) for p in parts] == [(0, 18), (18, 36), (36, 39.2)]
    assert all(p.input_end - p.input_start <= 18.7 + 1e-8 for p in parts)
    assert parts[0].input_start == 0
    assert parts[-1].input_end == 39.2


def test_offsets_once_and_ownership():
    part = list(windows(36))[1]
    words = token_words([{'text': ' hello', 'start': .2}, {'text': ' there', 'start': .5}],
                        input_start=17.65, input_end=36, segment_start=.1,
                        segment_end=1.0, starts_only=True)
    assert words[0]['start'] == pytest.approx(17.95)
    assert words[1]['start'] == pytest.approx(18.25)
    assert [w['text'] for w in retain_owned(words, part)] == ['there']


@pytest.mark.parametrize('tokens', [
    [{'text': ' hi', 'start': math.nan, 'duration': .1}],
    [{'text': ' hi', 'start': 20, 'duration': .1}],
    [{'text': ' hi', 'start': .5, 'duration': -.2}],
    [{'text': ' hi', 'start': .8, 'duration': .1}, {'text': ' there', 'start': .2, 'duration': .1}],
])
def test_invalid_token_times_fail(tokens):
    with pytest.raises(InvalidParakeetOutput):
        token_words(tokens, input_start=0, input_end=18)


def test_multiword_seam_only_and_real_repetition():
    before = [{'start': 17.8, 'end': 17.9, 'text': 'hello'},
              {'start': 17.9, 'end': 18, 'text': 'world'}]
    duplicate = [{'start': 17.8, 'end': 17.9, 'text': 'Hello,'},
                 {'start': 17.9, 'end': 18, 'text': 'world!'},
                 {'start': 18.2, 'end': 18.4, 'text': 'again'}]
    assert [w['text'] for w in repair_seam(before, duplicate, 18)] == ['again']
    assert len(repair_seam([before[-1]], [duplicate[1]], 18)) == 1


def test_assemble_and_empty():
    assert assemble([], 10) == []
    assert assemble([{'start': 0, 'end': .2, 'text': 'Yes.'},
                     {'start': 1.5, 'end': 1.8, 'text': 'yes'}], 2) == [
                         {'start': 0, 'end': .2, 'text': 'Yes.'},
                         {'start': 1.5, 'end': 1.8, 'text': 'yes'}]
    with pytest.raises(InvalidParakeetOutput):
        assemble([{'start': 1.1, 'end': 1, 'text': 'bad'}], 2)

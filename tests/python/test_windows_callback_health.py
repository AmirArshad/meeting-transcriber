from backend.audio.windows_callback_health import evaluate_callback_stalls


def test_evaluate_callback_stalls_warns_for_stalled_mic_and_desktop_streams():
    result = evaluate_callback_stalls(
        now=20.0,
        threshold_seconds=10.0,
        mixing_mode=True,
        last_mic_callback_time=5.0,
        last_desktop_callback_time=6.0,
        mic_warning_shown=False,
        desktop_warning_shown=False,
    )

    assert result == {
        'mic_elapsed': 15.0,
        'desktop_elapsed': 14.0,
        'warn_mic': True,
        'warn_desktop': True,
    }


def test_evaluate_callback_stalls_ignores_desktop_when_not_mixing():
    result = evaluate_callback_stalls(
        now=20.0,
        threshold_seconds=10.0,
        mixing_mode=False,
        last_mic_callback_time=15.0,
        last_desktop_callback_time=1.0,
        mic_warning_shown=False,
        desktop_warning_shown=False,
    )

    assert result == {
        'mic_elapsed': 5.0,
        'desktop_elapsed': None,
        'warn_mic': False,
        'warn_desktop': False,
    }


def test_evaluate_callback_stalls_respects_existing_warning_flags():
    result = evaluate_callback_stalls(
        now=20.0,
        threshold_seconds=10.0,
        mixing_mode=True,
        last_mic_callback_time=1.0,
        last_desktop_callback_time=1.0,
        mic_warning_shown=True,
        desktop_warning_shown=True,
    )

    assert result == {
        'mic_elapsed': 19.0,
        'desktop_elapsed': 19.0,
        'warn_mic': False,
        'warn_desktop': False,
    }

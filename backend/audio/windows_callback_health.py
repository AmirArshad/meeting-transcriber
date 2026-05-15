"""Helpers for Windows recorder callback health tracking."""


def evaluate_callback_stalls(
    *,
    now,
    threshold_seconds,
    mixing_mode,
    last_mic_callback_time,
    last_desktop_callback_time,
    mic_warning_shown,
    desktop_warning_shown,
):
    result = {
        'mic_elapsed': None,
        'desktop_elapsed': None,
        'warn_mic': False,
        'warn_desktop': False,
    }

    if last_mic_callback_time is not None:
        mic_elapsed = now - last_mic_callback_time
        result['mic_elapsed'] = mic_elapsed
        result['warn_mic'] = mic_elapsed > threshold_seconds and not mic_warning_shown

    if mixing_mode and last_desktop_callback_time is not None:
        desktop_elapsed = now - last_desktop_callback_time
        result['desktop_elapsed'] = desktop_elapsed
        result['warn_desktop'] = desktop_elapsed > threshold_seconds and not desktop_warning_shown

    return result

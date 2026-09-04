# Linux audio troubleshooting

The Linux recorder deliberately uses the Pulse-compatible PipeWire server via
`pulsectl` and SoundCard. It opens capture-only microphone and sink-monitor
streams. It must not open `hw:*` ALSA devices directly, request a full-duplex
playback/capture stream, or retry a stream after the server reports `ENOSPC`
(`No space left on device` / `set_hw_params`). A resource-exhaustion failure
disables desktop capture for that recording and preserves microphone audio.

If a USB DAC repeatedly clicks and audio devices disappear, stop the app and
reset the user audio stack:

```sh
systemctl --user restart pipewire pipewire-pulse wireplumber
```

Then confirm the devices have returned before recording again. The app's
`DESKTOP_AUDIO_RESOURCE_EXHAUSTED` warning is intentionally fail-closed: it is
not evidence that the DAC is unavailable permanently, and it does not authorize
an ALSA fallback or a broader Linux hardware-support claim.

For a persistent failure, inspect the host's user-journal entries for
PipeWire/WirePlumber and the USB audio device, and reduce competing audio
streams before retrying. Do not work around the issue by adding a raw ALSA
device string to the recorder.

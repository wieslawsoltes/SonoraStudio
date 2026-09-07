# Verification report

## Delivered results

Verification used Node.js 22.16.0 and headless Chromium 144.0.7559.96. The exact tool-produced results are included, not reconstructed summaries:

- `tests/artifacts/core-test-report.txt`: **42 passed, 0 failed**.
- `tests/artifacts/browser-report.json`: **20 passed, 0 failed**, 0 uncaught JavaScript errors, and 3 explicitly skipped platform capabilities.
- `tests/artifacts/multitrack.png`, `spectral.png`, `compact.png`: actual running application screenshots.
- `tests/artifacts/export-test.wav`: actual WAV downloaded through the export dialog.
- `tests/artifacts/import-test.wav`: generated mono import fixture.

The browser suite waits for original demo synthesis, source analysis and initialization before interacting. It does not replace the audio engine with a mock. Native Web Audio playback and OfflineAudioContext run in Chromium. The export dialog produces a real RIFF file with the requested rate, depth, channel count and duration. The source/project round-trip checks decoded samples, not just file names.

## Core coverage

Tests cover time formatting including rounding carry, dB conversion, rate-aware split/trim, locked clips, transactional history/rollback, selection notification coalescing, duplication, overlapping ripple spans, validation, fades, automation interpolation, min/max pyramid extrema, RMS/DC/peak statistics, forward/inverse FFT, malformed FFT inputs, selected-region processing, source immutability, normalization/headroom, 16/24/float32 WAV round-trips, integer clipping, float overs, RIFF padding, extended float metadata, malformed WAV rejection, spectral band suppression, zero-dB overlap-add reconstruction, and finite spectral images.

Four recorder tests instantiate the actual worklet class in a Node VM with a test MessagePort and synthetic audio blocks. They verify silent output/inactive state, exact requested start-frame behavior, mono mirroring, 4,096-frame stereo transfer, partial flush, and ignoring samples after stop. This validates the algorithm but does not test browser worklet loading, getUserMedia, permissions, hardware timing or microphone latency.

## Browser integration coverage

| Test | Result |
| --- | --- |
| Six real source assets, six tracks, sixteen clips and generated waveform geometry | Pass |
| Native playback, clock advance, nonzero PCM meters and stop reset | Pass |
| Active loop wraps within the configured time interval | Pass |
| Keyboard split and undo/redo retain source mapping | Pass |
| Duplicate and undo | Pass |
| Pointer clip movement with snapping bypass | Pass |
| Pointer edge trim and fade diamond edits | Pass |
| Mute, pan and single-transaction slider edits | Pass |
| Effects rack insertion | Pass |
| Offline stereo audio with real FX and 44.1 kHz resampling | Pass |
| Automation produces matching samples across full and partial render | Pass |
| Export dialog downloads a 24-bit stereo WAV | Pass |
| Waveform selection reverse and source-restoring undo | Pass |
| Worker spectrogram and computed frequency analysis | Pass |
| Pointer time-frequency rectangle selection | Pass |
| Portable project plus embedded PCM exact round-trip | Pass |
| File-input mono WAV preserves original rate/channels/frames | Pass |
| Automation point insertion/removal | Pass |
| 760 px compact layout without document overflow | Pass |
| Uncaught browser JavaScript errors | None |

## Explicit exclusions

**WebGPU execution:** the browser's navigation policy blocked normal URLs, so the standalone page was loaded using Playwright `set_content` into an in-memory document. That origin is not secure and does not expose `navigator.gpu`. The application selected its real Canvas 2D fallback. WGSL, adapter acquisition, GPU queue execution, device loss and graphics performance were not exercised. The UI never displayed a fake WebGPU badge.

**Microphone capture:** the harness is insecure and its browser policy sets `AudioCaptureAllowed=false`. Permissions were not bypassed. No actual or fake microphone stream was recorded. The implementation and isolated worklet tests are provided for validation on an authorized browser.

**IndexedDB:** the in-memory origin cannot access IndexedDB. The application handled the resulting storage denial and kept portable projects usable. Project serialization was tested separately, but IndexedDB transactions/restore were not exercised in this environment.

The expected storage-denial warning appears in the browser report; it is not suppressed. No claim is made that tests on one Chromium configuration certify all browsers or production workloads.

## Reproduce the included tests

```sh
npm test
npm run build
python -m pip install playwright
python -m playwright install chromium
npm run test:browser
```

The browser harness first checks `CHROMIUM_PATH`, defaults to `/usr/bin/chromium` when available, and otherwise uses the Playwright-installed Chromium. The default uses the bundled app in memory and requires no running server.

For an unrestricted local server run:

```sh
# Terminal 1
npm start

# Terminal 2
SONORA_TEST_URL=http://localhost:5173 npm run test:browser
```

A local secure-origin run can exercise adapter initialization and the conditional IndexedDB test. The harness requests software graphics and fake media for repeatability. It is not a substitute for testing a physical GPU or microphone. Do not change enterprise/browser security policies to force a test through.

## Additional release checks

On a supported browser served from localhost or HTTPS, verify that the status bar actually says WebGPU and that waveforms remain correct during resizing, high-DPI zoom, long sessions and device loss. Compare screenshots with the Canvas fallback. Record queue/CPU timings and adapter data rather than inferring GPU speed from the renderer name.

Grant microphone access normally, arm a track, record a short spoken test, stop, inspect and replay the result, and export it. Check denied permission, device unplug, suspend/resume and output-device changes. Measure round-trip latency before using overdubbing for timing-critical work; latency compensation is not included.

Change a project, wait for the Autosaved status, reload the site, and compare clip edits and source samples. Test quota failure, private browsing and browser storage clearing. Keep a portable `.sonora` backup throughout.

Finally, open exported 16/24/float32 WAV files in independent desktop audio editors. Stress long files, mixed source sample rates, automation boundaries, loop seams and effects tails. The included verification WAV is half a second of real rendered audio, not a mastering-reference suite.

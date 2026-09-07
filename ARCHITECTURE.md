# Sonora Studio — engine architecture

## 1. Dependency boundaries

The application uses plain ES modules. The served edition loads them directly; the standalone edition embeds the same modules and both background programs.

| Module | Responsibility |
| --- | --- |
| `model.js` | Document invariants, source/timeline transforms, transactional history and clip operations. No DOM or Web Audio dependency. |
| `audio-engine.js` | Live graph, offline graph, sample-clock transport, effects, automation, meters and recording lifecycle. |
| `dsp.js` | Typed-array signal processing, FFT, STFT reconstruction, peak pyramids, statistics and WAV codec. |
| `worker.js`, `worker-client.js` | Transferable RPC protocol and AudioBuffer/typed-array boundary. |
| `recorder-worklet.js` | Real-time PCM capture, sample-frame start, silent output, chunking and flush acknowledgement. |
| `renderer.js` | WebGPU initialization, WGSL instanced waveform rendering, visible geometry and fallback. |
| `persistence.js` | Portable project codec, file downloads and IndexedDB transactions. |
| `synth.js` | Original deterministic demo audio synthesis. |
| `app.js` | UI controller, command routing, gestures, dialogs and invalidation. |
| `styles.css`, `index.html`, `icons.js` | Workstation layout, semantic controls and original SVG icons. |
| `scripts/build.mjs` | Dependency-free bundling for this project's constrained named-module syntax. |

This build script is deliberately not a general-purpose JS parser. It rejects unsupported import/export declarations. Extending the module syntax requires extending the build or adopting a conventional bundler.

## 2. Immutable PCM, mutable document

An asset is `{ id, name, buffer, peaks?, stats?, spectrum? }`. `buffer` is an AudioBuffer whose samples are treated as immutable after publication. Assets live in a Map external to document snapshots. A clip references an asset ID and stores:

```js
{
  id, assetId, name,
  start,       // seconds on the session timeline
  offset,      // seconds into the original source
  duration,    // timeline duration, after playback-rate adjustment
  rate,        // 0.25–4.0, varispeed rather than pitch-preserving stretch
  gain,        // dB
  fadeIn, fadeOut, // seconds of clip time
  locked
}
```

For a session position `t` inside a clip:

```text
localTime  = t - clip.start
sourceTime = clip.offset + localTime * clip.rate
sample     = sourceTime * source.sampleRate
```

Split and trim use this same mapping, so source offsets remain correct for non-unit playback rates and mixed source sample rates. Left extension stops at source time zero; right extension stops at source duration.

Source processors copy the source, modify the chosen sample region, publish a new asset, and change only selected clip references. Undo restores the old asset ID instead of reconstructing or reverse-applying the DSP. Different clips using the original asset remain unchanged.

## 3. Transactions

`SessionStore.execute(label, mutation)` snapshots the document, applies the mutation, validates it, and rolls back on failure. `commitFrom(before, label)` supports continuous gestures: many pointer updates or range-input events become one history entry. `undo()` and `redo()` exchange document snapshots while sharing the asset Map.

Validation enforces asset references, unique track/clip IDs, time and gain bounds, effect parameter bounds, maximum counts, selection consistency, and source-range limits. Selection-only notifications do not rebuild audio graphs; identical selection requests do not emit a notification. Interactive double activation survives document-driven DOM replacement.

History is capped at 100 edits. This avoids PCM copies per gesture, but source processing still creates new PCM buffers. Old versions remain in memory during the session. There is no disk-backed source paging or history-aware asset garbage collector yet.

## 4. Signal graph

Live and offline rendering use the same `buildGraph()` and `scheduleRange()` implementations:

```text
AudioBufferSourceNode
  -> clip gain + scheduled fade envelope
  -> track input
  -> enabled effects in rack order
  -> StereoPannerNode
  -> track fader / mute / solo
  -> automation GainNode
  -> master GainNode
  -> output GainNode
  -> AudioDestinationNode
```

Live graph taps include track analyzers, master spectrum, and a channel splitter feeding independent left/right meters. Offline rendering uses `OfflineAudioContext` with a requested output sample rate. Browser-native source playback performs resampling; WAV import itself does not resample the source.

Clip fades interpolate in linear amplitude. Track automation points are expressed in dB and interpolate linearly in dB, implemented with positive exponential AudioParam ramps. Endpoint values come from the same interpolation function used during seek initialization. The browser tests compare full-range and partial-range automation samples.

Fader, mute/solo and pan changes update active nodes with short smoothing. Structural changes rebuild the graph at the current audio-clock position. Shutdown ramps the graph output before stopping/disconnecting sources. This reduces abrupt discontinuities but does not preserve filter/delay/convolution state across graph rebuilds.

### Effects

The EQ chains a low shelf, peaking biquad and high shelf. The compressor uses DynamicsCompressorNode. Reverb is a dry/wet deterministic stereo impulse through ConvolverNode, cached by sample rate and decay. Echo uses a filtered feedback delay. Saturation uses WaveShaperNode with 2× oversampling and dry/wet routing. All effects have explicit bypass and bounded parameters.

These effects are independently implemented node graphs, not emulations of Adobe DSP coefficients. Dry/wet mixing uses complementary linear gains; convolution uses the browser node’s impulse normalization. Stereo output is not a surround speaker matrix.

## 5. Transport and scheduling

The display position comes from `AudioContext.currentTime` relative to a transport anchor. The UI animation frame never advances the audio clock. Playback starts with a short scheduling lead. Each intersecting clip is scheduled with the correct source offset, source duration and playback rate.

The loop pump runs every 25 ms and schedules 200 ms ahead. The display wraps through the same loop interval. A generation token rejects stale asynchronous playback starts. Completed sources disconnect and leave the active source set.

This is a browser scheduling design, not a hard-real-time operating system guarantee. Background timer throttling or long main-thread stalls can exhaust loop lookahead. All intersecting clips are scheduled for a non-looping play range; this is not yet a streaming clip scheduler for very large projects.

Seek and selected-range offline renders begin effects from fresh state. They do not silently promise that a reverb tail at a range boundary will equal a crop of a longer render. Gain automation, clip fades and source positions are deterministic across seeks.

## 6. Microphone capture

The record path is:

```text
getUserMedia microphone
  -> MediaStreamAudioSourceNode
  -> SonoraRecorder AudioWorkletNode
  -> silent GainNode
  -> destination
```

Permission is requested only when recording starts. Echo cancellation, browser noise suppression and automatic gain requests are disabled. The worklet writes zeros to its output; monitoring is intentionally not enabled.

A start command carries an audio-context frame index. The worklet discards samples before that boundary, captures stereo float PCM into 4,096-frame chunks, mirrors mono input into the second channel, and transfers chunk buffers to the main thread. A flush command posts the final partial chunk before acknowledging completion. Recording stops tracks and disconnects nodes. The default safety duration is 15 minutes.

The sample-frame boundary aligns capture to the context timeline; it does not compensate external hardware latency or round-trip latency. Core tests cover capture algorithm behavior. No physical or fake microphone stream was exercised in the restricted verification environment.

## 7. Waveform renderer

Each source channel has a peak pyramid starting at 128 samples per block. Each higher level combines adjacent min/max pairs. The current samples-per-pixel value selects a level; high zoom reads raw source samples.

Visible clip rectangles are transformed into lane coordinates. Only visible rows, clipped x ranges and first two source channels generate bars. The GPU instance ABI is exactly 32 bytes:

```text
byte  0: float4 rectangle = x0, y0, x1, y1
byte 16: float4 color     = r, g, b, a
```

WGSL uses `vertex_index` to construct two triangles per instance. A 16-byte uniform contains logical viewport size plus padding. The pipeline converts logical pixels into NDC and alpha-composites the waveform over the DOM clip backgrounds.

The vertex buffer grows to a power-of-two capacity and is reused. `queue.writeBuffer()` transfers active instances; `draw(6, instanceCount)` emits the waveform pass. DPR scaling is capped at 2.5. Compilation errors, adapter failure and device loss switch to a Canvas 2D backend using the same geometry. A failed WebGPU canvas is replaced before requesting a different canvas context type.

Waveform rendering is invalidation-driven. Clip geometry, scroll and zoom mark it dirty. Transport updates move the DOM playhead separately. Meters update at approximately 25 Hz. GPU compute is not used for FFT or audio processing.

No GPU throughput or latency benchmark is claimed. `lastMs` is CPU-side render/submission time. The delivered browser screenshots show the tested Canvas fallback.

## 8. DSP worker

RPC requests contain a monotonically increasing ID, operation type and arguments. Promise results/errors are paired by ID. PCM is copied before transferring ownership so edits cannot detach active playback sources. Peak levels and spectral images transfer their backing arrays back to the UI.

FFT is iterative radix-2 with inverse scaling. Source spectral analysis uses Hann-windowed real samples. The spectrogram maps frequency logarithmically from 30 Hz to the lower of 20 kHz or Nyquist and maps magnitude to a heat palette.

Spectral attenuation uses a 2,048-sample STFT and 512-sample hop, square-root Hann analysis/synthesis windows, conjugate-symmetric bin gains, inverse FFT and normalization by accumulated window weight. Frequency boundaries use soft transitions. Time boundaries use a short crossfade. This is actual frequency-selective attenuation, not painting over a spectrogram. It is not neural restoration or arbitrary spectral healing.

The source gate applies an amplitude envelope and threshold. Peak/RMS/DC statistics are sample-derived; neither BS.1770 integrated loudness nor oversampled true peak is calculated.

## 9. WAV and projects

The encoder writes little-endian RIFF/WAVE, interleaved PCM, correctly sized/padded data chunks, clipping for integer targets, optional deterministic TPDF dither, and float samples without integer-style clipping. Twenty-four-bit PCM and multichannel output use WAVE_FORMAT_EXTENSIBLE; float output includes a fact chunk and extended format information. Decoder support includes PCM 8/16/24/32 and float32, including recognized extensible subformats. Unsupported encodings are rejected. Export UI outputs mono or stereo only.

Portable project shape:

```js
{
  application: 'Sonora Studio',
  version: 1,
  savedAt: '<ISO timestamp>',
  session: { /* validated version-1 document */ },
  assets: [ { id, name, wav: '<base64 float32 WAV>' } ]
}
```

Only referenced source assets are embedded. Source float32 values survive a project round-trip exactly. Undo stacks, unused library assets, UI layouts and derived caches are not serialized. On open, analysis caches are rebuilt. Base64 packaging and JSON parsing are currently main-thread operations and can stall for large projects.

IndexedDB stores document and audio in a single read/write transaction over two stores. Autosave is debounced and requeued if the document changes during a write. Failure does not prevent portable file export. Browser storage is convenience persistence, not an archival guarantee.

## 10. Security, performance and extension points

The shipped application has no remote service calls, account system, credentials, telemetry or external assets. File names are escaped before HTML insertion. Imported identifiers are restricted to bounded ASCII alphanumerics, underscores and hyphens; effect types are checked as own properties of the supported-type table. Import, track/clip counts, decoded memory and offline-output size have guardrails. Imported files are still untrusted; browser resource limits remain necessary. A production deployment should add a hosting-appropriate CSP that explicitly permits the app and its worker/worklet packaging strategy.

The next architectural additions for heavier workloads are disk-backed chunked PCM, history-aware asset reclamation, streamed project packaging, a bounded scheduler, worker-side geometry generation, sample-exact range controls, effect preroll/checkpoints, playback latency calibration, extensible buses/sends and a measured WebGPU performance suite. They are extension points, not delivered capabilities.

### Primary platform references

- WebGPU specification: https://www.w3.org/TR/webgpu/
- Web Audio API specification: https://www.w3.org/TR/webaudio-1.1/
- Microsoft RIFF chunk structure and word alignment: https://learn.microsoft.com/en-us/windows/win32/xaudio2/resource-interchange-file-format--riff-

The source is authoritative for Sonora-specific behavior; the references define the browser/file-format substrate, not proof of product completeness.

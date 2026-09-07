# Sonora Studio

**Audio, in its element.** A local-first browser audio workstation built in plain HTML, CSS, and JavaScript, with real multitrack editing, Web Audio processing, spectral tools, and WebGPU waveform rendering with a Canvas 2D fallback.

## Application

GitHub Pages deployment target: **https://wieslawsoltes.github.io/SonoraStudio/**

The full source, tests, documentation, and deployment workflow are being imported from the verified Sonora Studio source package.

## Local development

```sh
git clone https://github.com/wieslawsoltes/SonoraStudio.git
cd SonoraStudio
npm start
```

Open `http://localhost:5173`. Node.js 20 or newer is required for the development server; there are no application or build dependencies to install.

```sh
npm test
npm run build
```

## Scope

Independent software with an Audition-inspired workflow, not Adobe Audition or complete Audition feature parity. No Adobe assets or proprietary recordings are included. Graphics use WebGPU where available; audio processing uses Web Audio and JavaScript workers.

License: MIT.

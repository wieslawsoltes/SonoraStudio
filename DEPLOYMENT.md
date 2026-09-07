# GitHub Pages deployment

Repository: https://github.com/wieslawsoltes/SonoraStudio

Site: https://wieslawsoltes.github.io/SonoraStudio/

The Pages workflow tests the source, builds the dependency-free standalone HTML, stages it as `site/index.html`, and deploys the artifact with GitHub Pages. It is triggered by pushes to `main` and can be started manually. Pull requests run validation without deployment.

## Local verification

```sh
npm test
npm run build
```

`dist/sonora-studio.html` contains its styles, application script, icon, DSP worker, and recording worklet. The published page therefore has no root-relative resource URLs and works under the `/SonoraStudio/` project path. The application has no runtime CDN dependencies.

GitHub Pages serves the application over HTTPS. Availability of WebGPU, microphones, and browser storage still depends on the browser, device, and permissions. Microphone recording starts only after an explicit user action and browser permission.

## Permissions

The routine deployment workflow uses `contents: read`, `pages: write`, and `id-token: write`. It does not require a personal access token or application credentials.

The one-time source import uses a SHA-256-verified archive and a normal fast-forward commit. Its temporary contents-write permission and import step are removed after importing the delivered source.

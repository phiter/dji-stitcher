# DJI Stitcher

Browser-based stitcher that turns the sphere panorama photos of a DJI drone into a full-resolution 360° panorama or a "little planet" image. Everything runs on the client: photos never leave your device.

## Features

- Stitches the individual photos of a DJI sphere panorama (26 for the Mini 2 SE, 33 for the Mini 5 Pro, any count works) into an equirectangular 360° panorama.
- Little planet view (stereographic projection) with adjustable field of view and rotation, exported as 1:1, 16:9 or 9:16.
- Exports up to the largest size a browser canvas can hold (about 134 MP), as JPEG or PNG. 360° JPEGs carry Google photo-sphere XMP so photo services and viewers recognise them.
- Built-in 360° viewer for previewing the result.
- Fills sky and ground the photos do not cover with a smooth extension of the edge colours (can be turned off).

## Getting started

Requires Node.js 22 or newer and a browser with WebGL 2 (developed and tested in Chrome).

```sh
npm install
npm run dev
```

Open the printed address, drop the photos (or their folder) of one sphere panorama and press **Stitch panorama**. Select the photos of a single panorama at a time; the app warns when a selection looks like several panoramas or covers too little of the sphere.

Other scripts:

| Script | Purpose |
| --- | --- |
| `npm run build` | Type-check and create the production build in `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Run the unit tests (the real-data test is skipped without a `PANORAMAS/` folder) |
| `npm run e2e` | Drive system Chrome through the whole flow (needs `npm run dev` running) |

## How it works

1. **Metadata:** the DJI gimbal yaw, pitch and roll from each photo's XMP give an initial orientation per photo.
2. **Alignment** (Web Worker): ORB features from OpenCV.js are matched between photos that should overlap, gated by the expected position. A bundle adjustment then refines every photo's orientation together with the focal length and lens distortion. Several focal length guesses are tried when the metadata is inaccurate.
3. **Exposure:** per-photo gains and a vignetting model are estimated from the overlaps so brightness and colour match.
4. **Rendering** (WebGL 2): every output pixel is projected into all photos and blended in four frequency bands, so exposure differences fade smoothly while detail comes from a single photo. Output is rendered in tiles, which keeps very large images possible.

## Project layout

- `src/lib/align/`: feature detection, matching, bundle adjustment and exposure estimation
- `src/lib/render/`: WebGL renderer, shaders, sky/ground fill and JPEG/PNG encoding
- `src/lib/`: camera geometry, DJI metadata, photo selection checks and output sizes
- `src/workers/`: the alignment worker
- `src/components/`: React UI
- `tests/`: unit tests, a synthetic 33-photo set and an optional real-data test
- `scripts/e2e.mjs`: end-to-end script

## Notes and limits

- Only DJI photos with gimbal angles in their XMP are supported; other files are skipped with a message.
- The first stitch downloads a large worker (about 15 MB) because it bundles OpenCV.js.
- Photos are decoded at full resolution but capped by what the largest output can show and by GPU memory, so very large sources are downscaled on the GPU.
- Large exports need a lot of memory; if a size fails, choose a smaller one.
- Sample photos are not part of the repository. To run the real-data test or the e2e script, put DJI sphere sets in `PANORAMAS/<set>/` (the folder is git-ignored).

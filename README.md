# Loopy to Logic

Migrate a **Loopy Pro** project to **Logic Pro for iPad**. Everything runs in the browser, on the device – nothing is uploaded, there is no server and no account. After the first load it works offline.

From a zipped `.lpproj` it produces:

| Output | What it is |
|---|---|
| **Audio stems** | One 24-bit WAV per colour group that holds audio loops, arranged as Loopy's sequencer plays them, starting at bar 1. Loops pitched by ±12 (or any amount) are pitch-shifted at constant tempo. |
| **Instrument MIDI** | One `.mid` file per instrument, across the whole song. A loop's canvas pitch setting is applied as a transposition, as Loopy does. |
| **Automation MIDI** | One file, one track per automation lane, each on its own CC (CC20 upwards) and channel. CC0 is never used because hosts treat it as bank select. |
| **Manifest** | Markdown listing every channel, insert effect (in order), preset, send, bus, master chain, automation target, and – with a baseline project – each tweak from the factory preset. |

## Using it on an iPad

1. Open the site in **Safari**. Tap Share → **Add to Home Screen** to keep it as an app.
2. In the Files app, zip your project folder (long-press `My Project.lpproj` → **Compress**).
3. Tap **Loopy project** and choose the zip. A summary appears.
4. *(Optional)* Choose a **baseline project**: a Loopy project with one untouched instance of every preset used. The manifest then lists what you changed from each preset.
5. Tick the outputs and tap **Export**.
6. Save the files. **Download everything as one zip** is the easy route; if a large stem fails inside the zip, save files one at a time (**Download**, or **Share / Save to Files** for the share sheet).

Stems are about 90 MB each for a six-minute song. They are written in one-second windows, so memory use stays low, but a Blob of that size is still held until you save it. If Safari struggles, export stems on their own, one tick at a time.

### What the tool decides for you

- **Unused loops** (no arrangement segments) are listed in the manifest and left out of the stems.
- **Audio loops replaced by MIDI** – an audio loop whose arrangement positions exactly match a MIDI loop driving an instrument – are flagged and left out of the stems. Both can be included under *More options*.
- **Group faders are not applied to stems.** Stems carry each loop's own volume only; colour-channel levels are in the manifest so you set them in Logic.
- **Automation targets.** Loopy does not store which control a slider drives. A lane whose final value / 127 equals exactly one non-zero saved send is proposed automatically; targets you have confirmed live in `data/automation-targets.json`. Anything else is listed as "to confirm".

## Extending the lookups

Lookups are plain JSON in `data/`, bundled into the build:

| File | Purpose |
|---|---|
| `numa-sounds.json` | Numa Player sound UUID → sound name. The project stores only the UUID. |
| `turnado-subpresets.json` | Turnado slot sub-preset name → effect family. |
| `odc-params.json` | Other Desert Cities parameter names by index (the first 34 are filled in; add the rest in order). |
| `automation-targets.json` | Confirmed automation lane → send mapping, keyed by lane title. |

Edit the file and redeploy (or `npm run build`). Parameters of plug-ins without a name map are shown as the keys Loopy stores.

## Development

```bash
npm install
npm test          # acceptance tests against the fixtures
npm run dev       # local dev server
npm run build     # production build in dist/
```

The acceptance tests run in Node against two real projects in `fixtures/` (git-ignored because they hold audio):

- `fixtures/raw/Adabadaba_Dub.zip` and `fixtures/raw/Logic_Migration_Project.zip` (the zips)
- `fixtures/dub/` and `fixtures/logic/` (the same projects unzipped)

Without them the tests cannot run; the site still builds.

### Layout

```
src/lib/        parsing and generation – no DOM, no Node-only APIs
  project.js      Project.sqlite -> object graph (sql.js)
  bplist.js       binary plist reader
  effects.js      effect decoding, presets, Turnado
  instruments.js  J6 / DigiStix / Numa state
  mixer.js        channels, buses, sends, master, unused/superseded loops
  baseline.js     diff against an untouched baseline project
  automation.js   automation lanes and target proposals
  arrangement.js  placements, MIDI per instrument (offset, canvas pitch)
  midi.js / smf.js   Loopy MIDI records, Standard MIDI File writer
  audio.js        AIFF reader, 24-bit WAV, SoundTouch pitch shifting
  stems.js        stem planning and streaming render
  manifest.js     Markdown manifest
src/app/        the page: zip reading (File slices), engine, UI, service worker
scripts/        exploration and command-line export helpers
```

`src/lib` is deliberately separate from the UI so it can later target Logic Pro for Mac, where AAF/FCPXML import could place regions automatically.

### Deployment

`.github/workflows/pages.yml` builds on every push to `main` and publishes `dist/` to GitHub Pages. In the repository settings set **Pages → Source** to **GitHub Actions**. The site uses relative paths, so it works under any repository name.

## Known limits

- **Segment offset sign.** MIDI and audio segments carry an `offset`; the sign is unconfirmed (it shifts J6 B and Keys by about half a beat). Audio loops in the test project have no offset, so stems are unaffected. Check MIDI timing by ear; the sign is a single parameter (`offsetSign`).
- **Zip64** archives (over 4 GB, or over 65,535 files) are not supported.
- Only PCM AIFF is read (16, 24 or 32-bit; big-endian or `sowt`).
- Track `speed` other than 1 on audio loops is reported but not applied.
- Pitch shifting uses SoundTouch, so shifted loops are good, not transparent.
- Not tested in Safari on a physical iPad yet – tested in Chromium (including offline) and in Node.

## Licences

Application code: [MIT](LICENSE). Third-party: [SoundTouch / soundtouchjs](https://github.com/cutterbl/SoundTouchJS) is **LGPL-2.1** and is used as a separate, replaceable library; `sql.js` (MIT), `fflate` (MIT), `vite-plugin-pwa` (MIT).

# Wedge developer guide

Everything you need to build, test and change Wedge. For using Wedge, see the [README](README.md).

## Build from source

```bash
npm install
npm start          # run it
npm test           # end-to-end self-test: converts generated fixtures through every engine
npm run dist:win   # Windows installer (dist:mac / dist:linux on those systems)
```

Each platform has to be built on that OS. Pushing a `v*` tag (or running the **Build installers**
workflow from the Actions tab) builds and self-tests Wedge on Windows, macOS and Linux runners.

The native Windows pieces (the right-click handler `build/shell/WedgeShell.dll` and the shell helper
`src/main/native/wedge-helper.exe`) are checked in. To rebuild them, install
[llvm-mingw](https://github.com/mstorsjo/llvm-mingw) and run `npm run build:shell`.

**LibreOffice is optional.** If it's installed, Wedge uses it for high-fidelity Word, Excel and
PowerPoint → PDF and to open DOC, ODT, RTF, PPT, ODP and Keynote files.

## Releasing

1. Bump `version` in `package.json`, build the Windows installer with `npm run dist:win`, and create a GitHub release
   (for example `v0.2.0`) with `dist/Wedge Setup x.y.z.exe` attached.
2. In the **Actions** tab, run **Build installers** and type the release tag. The macOS and Linux builds are
   attached to that release as beta downloads. Once SignPath signing is set up, approve the signing request
   in SignPath and the signed Windows installer replaces the one from step 1.

## Windows code signing (SignPath)

Windows installers are signed for free through the [SignPath Foundation](https://signpath.org/) program
for open-source projects. The **Build installers** workflow does it automatically once these are set:

| Where (GitHub repo → Settings → Secrets and variables → Actions) | Name | Value |
| --- | --- | --- |
| Secrets | `SIGNPATH_API_TOKEN` | API token of a SignPath user with the *submitter* role |
| Variables | `SIGNPATH_ORGANIZATION_ID` | Your SignPath organization ID |
| Variables (optional) | `SIGNPATH_PROJECT_SLUG` | Project slug, if it isn't `wedge` |
| Variables (optional) | `SIGNPATH_SIGNING_POLICY_SLUG` | Signing policy slug, if it isn't `release-signing` |

In SignPath, the project uses the artifact configuration in [.signpath/artifact-configuration.xml](.signpath/artifact-configuration.xml),
the predefined GitHub.com trusted build system, and the SignPath GitHub App installed on this repository.
Each signing request waits for an approver, then the signed installer replaces the unsigned one and, when
the workflow is run with a release tag, is attached to that release.

Without `SIGNPATH_API_TOKEN` the signing steps are skipped and the build stays unsigned.

## Platform notes

- **Windows:** a small native helper (`src/main/native/wedge-helper.exe`, source in `src/shell`) tells Wedge
  whether the cursor is over Explorer or the desktop and which file was clicked.
- **macOS:** needs **Accessibility** permission for the global key/mouse hook; Settings shows a button for it.
- **Linux:** works on X11 with `xdotool` and `xprop` installed. On Wayland the hook only sees XWayland apps.
- Set `WEDGE_DEBUG=1` to log the gesture flow to the terminal.

## Project layout

```
src/main/main.js          tray, wheel, settings window, IPC
src/main/gesture.js       system-wide "hold the shortcut + click" detection (uiohook-napi)
src/main/context.js       is the cursor over a file manager, and which file was clicked
src/main/shellmenu.js     the Windows 11 right-click menu (sparse package + WedgeShell.dll)
src/main/catalog.js       every conversion, tool, action and extension
src/main/engines/         image, media, pdf, docs, sheets, archive, subtitles, office, editors
src/renderer/             wheel, settings window, editors, shelf
src/shell/                C++ sources for the Windows helper and right-click handler
scripts/self-test.js      end-to-end engine test (runs inside Electron)
```

To add a conversion, add one entry in `src/main/catalog.js`; the wheel picks it up automatically.

## License

Wedge is released under the [GNU AGPL-3.0](LICENSE) because it bundles MuPDF (AGPL-3.0) and a GPL
build of FFmpeg. To ship it under a different license, swap MuPDF for a commercially licensed build
(or pdf.js) and use an LGPL FFmpeg build.

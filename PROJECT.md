# Stream Companion (desktop app)

Electron app that runs on the streaming PC. In sync mode the main process
(`src/main/index.js`) starts `src/server/local-server.js` (HTTP 8877, overlay
WebSocket 8878), which connects to the Tower server
(`stream.soupymediagroup.com`) through `src/server/sync-client.js`. The overlays in
`src/overlays/*.html` are loaded into OBS as browser sources.

## How this source was recovered (2026-10-18)

The original source tree was lost. This project was rebuilt from the shipped
installer `Stream Companion Setup 1.3.2.exe` (from Tower `app-binary/`):

- `src/` and `package.json` come from `resources/app.asar`.
- **Electron 28.3.3** comes from the version resource of `Stream Companion.exe`.
- **electron-builder 24.13.3** was chosen because the installer's decompressed
  NSIS script matches it exactly. electron-builder 26.x makes a different
  script (it uses PowerShell to detect running processes) and also changes the
  exe's asar-integrity resource.
- `appId` **com.soupymediagroup.streamcompanion** comes from the NSIS script.
  The installer's registry/mutex GUID `ce9759b6-98d1-5de8-8c6e-afea8d4c36ad` is
  electron-builder's UUIDv5 of that appId, which confirms it.
- `win.signAndEditExecutable: false`: the shipped `Stream Companion.exe` still
  carries the stock Electron version info and icon.
- NSIS options are the defaults: one-click, per-user install to
  `%LOCALAPPDATA%\Programs\stream-companion`, desktop and Start-menu shortcuts.
- `resources/overlays` is the same as `src/overlays`, so it comes from
  `extraResources`.
- `resources/app-update.yml` comes from the generic publish URL.
- `package-lock.json` was rebuilt so that every bundled package has the exact
  version and folder layout that shipped. The caret ranges in `package.json`
  are the original ones; the lockfile does the pinning. **Use `npm ci`** so the
  lockfile is not re-resolved.

### Verification

A rebuild compared against the shipped 1.3.2 gave these results:

- `app.asar` is **byte-identical**. All 1,973 files hash the same.
- All 88 files in the installed app directory are identical: the exe, the
  DLLs, the `.pak` files, `overlays/` and `app-update.yml`.
- The NSIS script strings are identical.
- The installer exe differs only in archive timestamps and sizes: 10 bytes of
  the NSIS header, and the 7z is 3 bytes smaller. Neither build is signed.

### Not recovered

- Git history and any notes, scripts, `.env` or dev tooling outside the asar.
  The `scripts` and any other devDependencies were stripped at build time, so
  the ones in `package.json` here are new.
- The app icon. None was set, so the default Electron icon is used.
  `src/main/index.js` points at `src/renderer/icon.png`, but that file never
  shipped.
- The original source location was probably `C:\Streaming\Programs\StreamCompanion`
  on the streaming PC, because `local-server.js` defaults `overlaysDir` to
  `C:\Streaming\Programs\StreamCompanion\src\overlays`. The installed app
  serves overlays from that path, not from `resources/overlays`, unless
  `OVERLAYS_DIR` is set.

## Build

```
npm ci
npm run dist        # -> dist/Stream Companion Setup <version>.exe, .blockmap, latest.yml
npm start           # run locally
```

Electron and electron-builder are pinned to exact versions. Keep them pinned
unless you are upgrading on purpose. After an upgrade the payload will no longer
match 1.3.2.

## Releases (auto-update)

1. Bump `version` in `package.json`, then run `npm run dist`.
2. Upload these three files from `dist/` to Tower
   `/mnt/user/appdata/stream-companion/app-binary/`:
   `Stream Companion Setup X.Y.Z.exe`, its `.blockmap` and `latest.yml`. That
   folder is served at `https://stream.soupymediagroup.com/app`.
3. Installed apps check that URL through electron-updater (generic provider,
   cache dir `stream-companion-updater`) and update themselves.

Releasing is outward-facing, so confirm with Kyle before uploading.

## Notes

- User data lives in `%APPDATA%\StreamCompanion\` (`settings.json`, which holds
  tokens, and `sounds/`). Never commit it.
- `src/server/index.js` is the old standalone server and is dead code. It was
  kept in the payload so the rebuild matches 1.3.2.

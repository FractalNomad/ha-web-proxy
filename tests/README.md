# Panel layout regression tests

```sh
npm ci
npx playwright install chromium
npm test
```

To use an existing Chromium installation instead:

```sh
BROWSER_PATH=/usr/bin/chromium npm test
```

The tests execute the actual panel JavaScript in Chromium. A fixture places it
inside an auto-height `ha-panel-custom` wrapper beneath a shadow root, as in HA.
Session responses and iframe content are mocked; no HA instance or credentials
are used.

Coverage: loading, iframe and error states; desktop sidebar, mobile safe areas,
sidebar-adjusted horizontal insets, block/flex wrappers, viewport resizing,
absence of page overflow, iframe identity during resize, matching JS revisions,
and the safe-area registration flag. These are layout regression tests, not a
replacement for verification in the installed HA frontend/companion app.

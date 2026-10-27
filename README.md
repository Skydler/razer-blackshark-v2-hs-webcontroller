# BlackShark / Local Control

An English-only, local-first WebHID controller for the **Razer BlackShark V2
HyperSpeed**. Plain HTML, CSS, and JavaScript modules. No runtime dependencies,
package installation, backend, account, or build step.

**Experimental hardware support:** This implementation has automated tests and
browser smoke checks, but has not been tested against a physical headset.
Reverse-engineered commands can behave differently across firmware versions.
Do not treat read-back verification as a guarantee against hardware damage.

## Run locally

With Python 3 installed, run from this folder:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

Open **http://localhost:8080** in desktop Chrome, Edge, or Brave. `npm start` runs the
same command if Node.js/npm is installed. Do not open `index.html` directly:
JavaScript modules and device APIs need a suitable origin.

Select **Explore demo** to try the interface without connecting hardware. The
demo uses simulated data and cannot write to a headset.

## Connect and edit

1. Close Razer Synapse and other tools using the headset's HID interface.
2. Connect the wireless dongle or the powered-on headset's USB-C cable.
3. Click **Connect headset** and select its vendor control interface.
4. The app reads current settings. It does not write anything on connection.
5. Check **Enable device editing** to unlock controls for this session.
6. Adjust a local draft, choose an Apply/Save action, and confirm the write.

The app supports only Razer vendor ID `1532` with product ID `0565` (2.4 GHz
dongle) or `056e` (USB-C), on vendor usage page `ff14` or `ff00`, with both input
and output report ID `02`. The experimental `0566` variant is intentionally not
included. Device names and IDs alone are not a hardware authentication scheme.

### Linux setup: “Failed to open the device”

Chrome, Edge, and Brave can show the device picker even when the current user
cannot open the underlying `/dev/hidraw*` node. Browser permission does not
override OS permissions. The app catches this error and displays it on the page;
an empty developer console does not mean opening succeeded.

On Fedora and other systemd-based desktop distributions, the included udev rule
grants the **active local desktop user** access to only the supported headset
product IDs. It does not make all HID devices world-writable. Review
`udev/70-blackshark-local-control.rules`, then run from this project folder:

```sh
sudo install -m 0644 udev/70-blackshark-local-control.rules /etc/udev/rules.d/70-blackshark-local-control.rules
sudo udevadm control --reload-rules
```

Unplug and reconnect the dongle or USB cable so udev applies the rule. Reload the
app and click **Connect headset** again. The numeric `hidraw` node can change
after reconnecting; the rule matches USB IDs, not a particular node number.

These commands change system device-access policy and require administrator
approval. The app never installs this rule itself. The rule must run before
`73-seat-late.rules`, which applies the active-session access control list.
It is intended for local graphical sessions, not SSH or headless sessions.

If opening still fails, close other headset controllers, check whether Brave is
installed in a Flatpak or Snap sandbox, and check its device-access restrictions.
Do not run the browser as root, disable its sandbox, or use a blanket
`chmod 666 /dev/hidraw*` workaround.

## Features

- Battery, charging, physical mic-mute status, firmware, and serial read-out.
- Ten-band hardware EQ, with local Flat, Warm bass, and Voice focus drafts.
- Factory Music, Game, Movie, and Flat preset selection.
- Hardware sidetone and level, sleep timer, Bluetooth DND, and dongle LED mode.
- A quiet five-second test tone and optional microphone-level meter.
- Manual refresh, bounded local diagnostics, disconnect, and permission removal.
- Responsive keyboard-accessible UI, labeled controls, and reduced-motion support.

## Safety and privacy changes

- **No raw-command console.** Packet creation accepts only known commands,
  domains, lengths, and value ranges. Excess data is rejected, not truncated.
- **No automatic reconnect.** Each session starts with a device-picker action,
  even if permission was granted previously. Initial synchronization is read-only.
- **No live-preview writes.** EQ movement and draft presets change browser
  state only. Applying custom EQ performs one curve write, followed by a latch
  sequence and read-back. These settings may persist in the device.
- **Editing is locked by default.** Each write needs session editing permission
  and a confirmation dialog. Only changed ordinary settings are written, except
  that enabling sidetone also reapplies its level using the controller's
  enable-then-level sequence, even if the stored level already matches.
- **No claimed factory reset.** There is no verified firmware-reset command in
  the app. A sequence of guessed defaults is not presented as a reset.
- **Fail-closed transport.** Requests are serialized and matched by device,
  report ID, sequence, command, and domain. Response length, checksum, ACK,
  payload count, and relevant values are checked. Transport/protocol faults
  close the session and cancel queued traffic. No automatic retries are made.
- **Read-back is required.** Mismatched values or failed write sequences lock
  editing. Some writes may already have succeeded; there is no atomic commit,
  undo, or automatic rollback. Read the device again or reconnect before editing.
- **Audio cleanup.** Microphone capture is optional, meter-only, and limited to
  30 seconds including the permission wait. Late permission results are stopped.
  Setup errors, Stop audio, device disconnect, page hiding, and page exit stop
  tracks and close audio contexts. Hiding the page also disconnects HID.
- **No app telemetry or remote dependencies.** No recording, upload, persistent
  browser storage, service worker, analytics, remote fonts, or external scripts.
  A Content Security Policy blocks app-initiated network connections and inline
  scripts. Hosting providers still receive ordinary page/asset requests and may
  retain access logs; this is not anonymity from your host.

The microphone meter uses your browser-selected/default input, which is not
necessarily the Razer headset. The tone uses the browser-selected audio output.
Sending hardware sidetone settings does **not** require browser microphone
permission. Read-back confirms the saved registers, not audible loopback.

### Sidetone is enabled but silent

Keep system/headset volume at a comfortable level and check that the physical
mic switch is unmuted. Set sidetone to a nonzero level (for example 12), then
**Save device settings** and confirm. The sidetone section shows the last
device-reported enable state and level, separately from the unsaved controls.

If sidetone was already enabled before updating this app, disable and save it
once, then enable it and save again. Enabling now always sends both the enable
and level commands in sequence. This restores the enable-then-level behavior; it is
not yet confirmed to fix silent loopback on every firmware.

The moving microphone meter only confirms browser input capture. It never
plays microphone audio through the speakers. If hardware sidetone is still
silent after verified read-back, note the firmware, USB connection type, and
last reported sidetone state/level. Do not send undocumented commands or turn
off response validation to force a result.

**Discard draft** discards only unsent edits; it does not undo a prior hardware
write. **Read device again** discards local drafts after confirmation. Automatic
15-second status reads update telemetry and the active preset, not your EQ draft.
Use manual refresh after changing EQ or settings through another device or app.

## Deploy to GitHub Pages later

All asset URLs are relative. The same files work at an origin root or a project
URL such as `https://USERNAME.github.io/REPOSITORY/`. HTTPS on GitHub Pages
satisfies the secure-context requirement. No environment variables, API keys,
custom base path, or build output are required. Device and microphone permissions
are associated with the website origin, not the repository folder; avoid hosting
untrusted apps on the same origin as this controller.

A **manual-only** workflow is provided in `.github/workflows/pages.yml`. Nothing
is published merely by adding or pushing these files.

When you are ready:

1. Push this project to your own GitHub repository.
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. In **Actions**, open **Deploy to GitHub Pages** and choose **Run workflow**
   on your default branch. Keep the `github-pages` environment restricted to
   trusted deployment branches.
4. Open the deployment URL shown by the completed job.

The workflow checks syntax, runs unit tests, stages only public application and
license files, and deploys that artifact. Actions are pinned to commit SHAs.
Repository write permission is not granted, and deployment permissions are
limited to the deployment job. Review and update the pinned actions over time.

For branch-based Pages instead, choose **Deploy from a branch** and the
repository root. This also serves the repository's documentation and tests as
public static files; the Actions workflow avoids publishing those files.

GitHub Pages does not support custom response headers. The CSP is therefore
included in HTML. A host with response-header support can additionally set
`Content-Security-Policy: frame-ancestors 'none'` and a restrictive
`Permissions-Policy`. Do not embed this controller in another site.

## Development and tests

Node.js 22 or newer is needed for tests; CI uses Node.js 24. No `npm install`
is needed.

```sh
npm test
npm run check
```

The tests use the actual protocol, controller, transport, and audio modules with
fake hardware. They cover packet validation, ACK matching, value limits, FIFO
traffic, timeouts, session cancellation, late send rejection, read-back failure,
explicit write gating, and microphone cleanup. Synthetic packet fixtures follow
the protocol implementation; passing tests does not prove firmware compatibility.

### Layout

| Path | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `icon.svg` | Static English UI and content security policy |
| `src/protocol.js` | Packet encoding, validation, allowlist, device filtering |
| `src/transport.js` | Single-device session, FIFO request queue, timeout and cancellation |
| `src/controller.js` | Device reads, permitted writes, read-back verification |
| `src/audio.js` | Bounded microphone and tone sessions |
| `src/app.js` | UI, local drafts, confirmation, lifecycle, demo |
| `tests/` | Hardware-free Node.js tests |

## Protocol limitations

The controller uses different IN/OUT checksum seeds, signed EQ encoding with a +5 outbound
offset, and custom-preset latch sequence. It deliberately does not try multiple
checksums, undocumented commands, alternate domains, or unsupported device IDs
when validation fails. Unexpected firmware responses require investigation, not
relaxed validation. The inferred response length/ACK conventions need real-device
confirmation. Start by checking read-only connection before enabling any writes.

## License

MIT; see `LICENSE`. Independent software, not
affiliated with Razer.

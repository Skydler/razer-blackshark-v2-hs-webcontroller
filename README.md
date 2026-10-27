# BlackShark / Local Control

A personal, local-first WebHID controller for the **Razer BlackShark V2
HyperSpeed**. Plain HTML, CSS, and JavaScript modules. No runtime dependencies,
package installation, backend, account, or build step.

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
- Ten-band hardware EQ with silver faders, a draft-versus-last-read curve,
  and local Flat, Warm bass, and Voice focus drafts. The plot connects band
  gains; it is not a measured frequency response.
- Factory Music, Game, Movie, and Flat preset selection.
- Hardware sidetone and level, sleep timer, Bluetooth DND, and dongle LED mode.
- A quiet five-second test tone and optional microphone-level meter.
- Manual refresh, bounded local diagnostics, disconnect, and permission removal.
- Responsive keyboard-accessible UI, labeled controls, and reduced-motion support.

The audio-console interface keeps connection status and editing permission
separate. On small screens, scroll the EQ console sideways to reach every band.
Focus a fader and use the arrow keys for one-decibel changes. Draft buttons show
which curve matches your current draft; **Discard draft** restores the last
read-back curve, not factory defaults.

## Safety and privacy

- **No raw-command console.** Packet creation accepts only known commands,
  domains, lengths, and value ranges. Excess data is rejected, not truncated.
- **No automatic reconnect.** Each session starts with a device-picker action,
  even if permission was granted previously. Initial synchronization is read-only.
- **No live-preview writes.** EQ movement and draft presets change browser
  state only. Applying custom EQ performs one curve write, followed by a latch
  sequence and read-back. These settings may persist in the device.
- **Editing is locked by default.** Each write needs session editing permission
  and a confirmation dialog. Only changed ordinary settings are written, except
  that enabling sidetone also reapplies its level using an
  enable-then-level sequence, even if the stored level already matches.
- **No claimed factory reset.** The app has no verified firmware-reset command.
  A sequence of guessed defaults is not presented as a reset.
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
explicit write gating, and microphone cleanup. Packet fixtures are synthetic;
passing tests does not prove firmware compatibility.

### Layout

| Path                                   | Purpose                                                             |
| -------------------------------------- | ------------------------------------------------------------------- |
| `index.html`, `styles.css`, `icon.svg` | Static English UI and content security policy                       |
| `src/protocol.js`                      | Packet encoding, validation, allowlist, device filtering            |
| `src/transport.js`                     | Single-device session, FIFO request queue, timeout and cancellation |
| `src/controller.js`                    | Device reads, permitted writes, read-back verification              |
| `src/audio.js`                         | Bounded microphone and tone sessions                                |
| `src/app.js`                           | UI, local drafts, confirmation, lifecycle, demo                     |
| `tests/`                               | Hardware-free Node.js tests                                         |

## Protocol limitations

The controller uses different IN/OUT checksum seeds, signed EQ encoding with a
+5 outbound offset, and a custom-preset latch sequence. It deliberately does not
try multiple checksums, undocumented commands, alternate domains, or unsupported device IDs
when validation fails. Unexpected firmware responses require investigation, not
relaxed validation. The inferred response length/ACK conventions need real-device
confirmation. Start by checking read-only connection before enabling any writes.

import { deviceFilters, FREQUENCIES, isSupportedDevice, PRESETS } from './protocol.js';
import { HidSession } from './transport.js';
import { HeadsetController } from './controller.js';
import { AudioTools } from './audio.js';

const $ = id => document.getElementById(id);
const curves = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [4, 3, 1, -2, -1, 0, 1, 2, 3, 2],
  voice: [-3, -2, -1, 0, 2, 3, 2, 1, 0, -1],
};
let controller = null;
let lastDevice = null;
let synced = false;
let busy = false;
let demo = false;
let epoch = 0;
let pollTimer = null;
let savedEq = Array(10).fill(0);
let draftEq = [...savedEq];
let savedSettings = null;
const supported = window.isSecureContext && 'hid' in navigator;

function log(message) {
  const entry = document.createElement('li');
  entry.textContent = `${new Date().toLocaleTimeString('en', { hour12: false })}  ${message}`;
  $('activity-log').prepend(entry);
  while ($('activity-log').children.length > 100) $('activity-log').lastElementChild.remove();
}

function feedback(message, error = false) {
  $('feedback').textContent = message;
  $('feedback').classList.toggle('error', error);
  $('feedback').hidden = false;
  log(message);
}

function editing() { return Boolean(controller && synced && $('edit-toggle').checked && !busy); }
function dirtyEq() { return draftEq.some((value, index) => value !== savedEq[index]); }

function updateControls() {
  const connected = Boolean(controller);
  const editable = editing();
  $('connect').disabled = !supported || connected || busy;
  $('disconnect').disabled = (!connected && !demo) || busy;
  $('demo').disabled = connected || busy || demo;
  $('refresh').disabled = !connected || busy;
  $('forget').disabled = !lastDevice || busy || typeof lastDevice.forget !== 'function';
  $('edit-toggle').disabled = !connected || !synced || busy;
  $('settings-controls').disabled = !editable;
  $('save-settings').disabled = !editable;
  $('eq-controls').disabled = !(editable || demo) || busy;
  $('apply-eq').disabled = !editable || !dirtyEq();
  $('factory-preset').disabled = !editable;
  $('apply-preset').disabled = !editable;
  $('led').disabled = !editable || controller?.session.device.productId !== 0x0565;
  $('tone').disabled = busy || document.hidden;
  $('mic').disabled = busy || document.hidden || !navigator.mediaDevices?.getUserMedia;
  $('stop-audio').disabled = !audio.active;
  if (controller) controller.writesEnabled = $('edit-toggle').checked && synced;
  $('connection-badge').textContent = demo ? 'Demo (no device access)' : connected ? (synced ? 'Connected' : 'Not synchronized') : 'Disconnected';
  $('connection-badge').className = `badge${demo ? ' demo' : connected && synced ? ' connected' : ''}`;
  $('editing-state').textContent = demo ? 'Demo only. Device editing is locked.' : connected && synced && $('edit-toggle').checked
    ? 'Device editing enabled' : connected ? 'Read-only connection' : 'Editing locked';
  $('edit-toggle').closest('.safety-bar').dataset.editing = String(connected && synced && $('edit-toggle').checked);
  $('equalizer').dataset.hasReading = String(demo || (connected && synced));
  $('eq-state').textContent = demo
    ? 'Demo draft only. Connect a headset to apply changes.'
    : !connected ? 'Connect to read your current curve.'
      : busy ? 'Device operation in progress. Controls are temporarily locked.'
        : !synced ? 'Read the device again or reconnect before editing.'
          : !editable ? 'Enable device editing to adjust your curve.'
            : dirtyEq() ? 'Unsaved draft. No changes sent to your headset.' : 'Draft matches the last device read-back.';
}

async function task(operation, success = '') {
  if (busy) return;
  busy = true;
  updateControls();
  try {
    await operation();
    if (success) feedback(success);
  } catch (error) {
    synced = false;
    $('edit-toggle').checked = false;
    const recovery = controller
      ? 'Read the device again or reconnect before editing.'
      : 'Use Connect headset to start a new session after resolving the error.';
    feedback(`${error.message} No automatic retry was made. ${recovery}`, true);
  } finally {
    busy = false;
    updateControls();
    schedulePoll();
  }
}

function renderStatus(status) {
  $('battery').replaceChildren(document.createTextNode(String(status.battery)));
  const unit = document.createElement('small');
  unit.textContent = '%';
  $('battery').append(unit);
  $('battery-fill').style.width = `${status.battery}%`;
  $('charge-state').textContent = status.charging ? 'Charging over USB' : 'Running on battery';
  $('current-preset').textContent = PRESETS[status.preset];
  $('mute-state').textContent = status.muted ? 'Muted' : 'Unmuted';
}

function renderEq(values) {
  draftEq = [...values];
  FREQUENCIES.forEach((_, index) => {
    $(`band-${index}`).value = draftEq[index];
    $(`gain-${index}`).textContent = `${draftEq[index] > 0 ? '+' : ''}${draftEq[index]}`;
    $(`band-${index}`).setAttribute('aria-valuetext', `${draftEq[index]} decibels`);
    $(`curve-point-${index}`).setAttribute('cy', String(12 + (6 - draftEq[index]) * 6));
  });
  // The plot shows discrete band gains, not a measured frequency response.
  const points = gains => gains.map((gain, index) => `${50 + index * 100},${12 + (6 - gain) * 6}`).join(' ');
  $('eq-draft-curve').setAttribute('points', points(draftEq));
  $('eq-saved-curve').setAttribute('points', points(savedEq));
  document.querySelectorAll('[data-curve]').forEach(button => {
    button.setAttribute('aria-pressed', String(curves[button.dataset.curve].every((gain, index) => gain === draftEq[index])));
  });
  updateControls();
}

function renderSettings(settings) {
  savedSettings = { ...settings };
  $('sidetone').checked = settings.sidetone;
  $('sidetone-level').value = settings.sidetoneLevel;
  $('sidetone-output').value = `${settings.sidetoneLevel} / 15`;
  $('sleep').value = settings.sleep;
  $('dnd').checked = settings.dnd;
  $('led').value = settings.led ?? 1;
  const sidetoneState = `Sidetone ${settings.sidetone ? 'on' : 'off'} · level ${settings.sidetoneLevel} / 15`;
  $('sidetone-status').textContent = `Last device read: ${sidetoneState}.`;
  if (!demo) log(`${sidetoneState}. Read-back confirms stored settings, not audible loopback.`);
}

function renderAll(data, device) {
  renderStatus(data.status);
  if (data.status.preset !== 255) $('factory-preset').value = data.status.preset;
  renderSettings(data.settings);
  savedEq = [...data.eq];
  renderEq(data.eq);
  const transport = device.productId === 0x0565 ? '2.4 GHz wireless dongle' : 'USB-C wired';
  $('device-description').textContent = demo ? 'Simulated data. Demo mode never opens a HID device.' : 'Connected directly. Settings are read from your headset.';
  $('transport-label').textContent = demo ? 'Simulated headset' : transport;
  $('detail-connection').textContent = transport;
  $('detail-firmware').textContent = data.firmware;
  $('detail-serial').textContent = data.serial || 'Not reported';
  $('detail-usb').textContent = `1532:${device.productId.toString(16).padStart(4, '0')}`;
}

function resetDisplay() {
  for (const id of ['battery', 'current-preset', 'mute-state', 'detail-connection', 'detail-firmware', 'detail-serial', 'detail-usb']) $(id).textContent = '—';
  $('battery-fill').style.width = '0%';
  $('charge-state').textContent = 'No device connected';
  $('device-description').textContent = 'Connect your headset to read its current settings.';
  $('transport-label').textContent = 'Awaiting device';
  savedEq = Array(10).fill(0);
  savedSettings = null;
  $('sidetone-status').textContent = 'Connect to read the hardware sidetone state.';
  renderEq(savedEq);
}

async function disconnect(message = 'Device disconnected. Browser permission is kept until you forget it.') {
  epoch++;
  clearTimeout(pollTimer);
  audio.stop();
  if ($('write-dialog').open) $('write-dialog').close('cancel');
  const previous = controller;
  controller = null;
  synced = false;
  demo = false;
  $('edit-toggle').checked = false;
  if (previous) {
    previous.writesEnabled = false;
  }
  const closing = previous?.session.close();
  resetDisplay();
  updateControls();
  if (message) log(message);
  await closing;
}

async function connect() {
  const generation = ++epoch;
  const devices = await navigator.hid.requestDevice({ filters: deviceFilters() });
  if (generation !== epoch || document.hidden) return;
  const device = devices.find(isSupportedDevice);
  if (!device) throw new Error('No supported control interface selected. Only 1532:0565 and 1532:056e with report ID 2 are supported.');
  try {
    await device.open();
  } catch (error) {
    throw new Error('The browser could not open the headset’s HID interface. On Linux, check hidraw permissions (see the Linux setup section in README.md). Also close other headset controllers. No headset settings were written.', { cause: error });
  }
  if (generation !== epoch || document.hidden) {
    await device.close();
    return;
  }
  lastDevice = device;
  demo = false;
  const session = new HidSession(device, { onFault: error => {
    if (controller?.session === session) {
      feedback(error.message, true);
      void disconnect('Device session closed after a protocol or transport fault.');
    }
  } });
  const nextController = new HeadsetController(session);
  controller = nextController;
  try {
    const data = await nextController.readAll();
    if (generation !== epoch) return;
    synced = true;
    renderAll(data, device);
    feedback('Headset connected in read-only mode. No settings were written.');
  } catch (error) {
    if (controller === nextController) await disconnect('Initial synchronization failed.');
    throw error;
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (!controller || !synced || document.hidden) return;
  pollTimer = setTimeout(async () => {
    if (busy || !controller) { schedulePoll(); return; }
    const active = controller;
    try {
      const status = await active.status();
      if (controller === active) renderStatus(status);
    } catch (error) {
      if (controller === active) {
        synced = false;
        $('edit-toggle').checked = false;
        feedback(error.message, true);
        updateControls();
      }
    }
    schedulePoll();
  }, 15_000);
}

async function confirmWrite(description, operation, success) {
  const active = controller;
  if (!editing() || !active) return;
  $('dialog-description').textContent = description;
  $('write-dialog').returnValue = 'cancel';
  const response = new Promise(resolve => $('write-dialog').addEventListener('close', () => resolve($('write-dialog').returnValue), { once: true }));
  $('write-dialog').showModal();
  if (await response !== 'apply' || controller !== active || !editing()) return;
  await task(() => operation(active), success);
}

const audio = new AudioTools({
  onMeter: level => {
    $('mic-level').style.width = `${level}%`;
    $('mic-meter').setAttribute('aria-valuenow', String(Math.round(level)));
  },
  onState: (state, label) => {
    $('audio-state').textContent = state === 'microphone' ? `Testing: ${label}. Stops automatically within 30 seconds.`
      : state === 'requesting' ? 'Waiting for microphone permission. You can cancel with Stop audio.'
        : state === 'tone' ? 'Playing a quiet 220 Hz tone. Stops after 5 seconds.' : 'Microphone is off.';
    $('stop-audio').disabled = state === 'idle';
  },
});

FREQUENCIES.forEach((frequency, index) => {
  const point = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  point.id = `curve-point-${index}`;
  point.setAttribute('cx', String(50 + index * 100));
  point.setAttribute('cy', '48');
  point.setAttribute('r', '3');
  $('eq-curve-points').append(point);
  const band = document.createElement('div');
  band.className = 'eq-band';
  const output = document.createElement('output');
  output.id = `gain-${index}`;
  output.htmlFor = `band-${index}`;
  output.textContent = '0';
  const input = document.createElement('input');
  input.id = `band-${index}`;
  input.type = 'range';
  input.min = '-9';
  input.max = '6';
  input.step = '1';
  input.value = '0';
  const hertz = frequency.endsWith('k') ? Number(frequency.slice(0, -1)) * 1000 : Number(frequency);
  input.setAttribute('aria-label', `${hertz} hertz EQ gain`);
  input.setAttribute('aria-valuetext', '0 decibels');
  input.addEventListener('input', () => {
    draftEq[index] = Number(input.value);
    renderEq(draftEq);
  });
  const label = document.createElement('label');
  label.htmlFor = input.id;
  label.textContent = frequency.endsWith('k') ? `${frequency.slice(0, -1)} kHz` : `${frequency} Hz`;
  band.append(output, input, label);
  $('eq-bands').append(band);
});

$('connect').addEventListener('click', () => task(connect));
$('disconnect').addEventListener('click', () => task(() => disconnect(), 'Disconnected. Audio capture has stopped.'));
$('edit-toggle').addEventListener('change', () => {
  updateControls();
  log($('edit-toggle').checked ? 'Device editing enabled for this session.' : 'Device editing locked.');
});
$('demo').addEventListener('click', () => {
  demo = true;
  renderAll({
    serial: 'DEMO-NOT-A-REAL-SERIAL', firmware: 'Demo firmware',
    status: { battery: 84, charging: false, muted: false, preset: 8 },
    settings: { sidetone: false, sidetoneLevel: 10, sleep: 15, dnd: false, led: 1 },
    eq: [3, 2, 1, 0, 0, 0, 1, 2, 3, 2],
  }, { productId: 0x0565 });
  updateControls();
  feedback('Demo mode: simulated device data. Try the EQ draft; no device access or writes are possible.');
});
document.querySelectorAll('[data-curve]').forEach(button => button.addEventListener('click', () => renderEq(curves[button.dataset.curve])));
$('discard-eq').addEventListener('click', () => renderEq(savedEq));
$('sidetone-level').addEventListener('input', () => { $('sidetone-output').value = `${$('sidetone-level').value} / 15`; });

$('apply-eq').addEventListener('click', () => {
  const desired = [...draftEq];
  void confirmWrite('This replaces your saved custom EQ curve, enables the hardware EQ, disables audio enhancement, and activates the Custom preset. Your factory presets are not overwritten.', async active => {
    const actual = await active.saveEq(desired);
    if (controller !== active) return;
    savedEq = [...actual];
    renderEq(actual);
    $('current-preset').textContent = 'Custom';
  }, 'Custom EQ applied and verified by device read-back.');
});
$('apply-preset').addEventListener('click', () => {
  const preset = Number($('factory-preset').value);
  void confirmWrite(`Activate the ${PRESETS[preset]} factory preset, enable hardware EQ, and disable audio enhancement? Any local EQ draft will be discarded.`, async active => {
    const result = await active.selectPreset(preset);
    if (controller !== active) return;
    savedEq = [...result.eq];
    renderEq(result.eq);
    $('current-preset').textContent = PRESETS[result.preset];
  }, 'Factory preset applied and verified.');
});
$('settings-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!savedSettings || !$('settings-form').reportValidity()) return;
  const settings = {
    sidetone: $('sidetone').checked, sidetoneLevel: Number($('sidetone-level').value),
    sleep: Number($('sleep').value), dnd: $('dnd').checked,
    ...(savedSettings.led !== undefined ? { led: Number($('led').value) } : {}),
  };
  void confirmWrite('Write your changed sidetone, power, call-blocking, and dongle indicator settings to the device?', async active => {
    const actual = await active.saveSettings(settings);
    if (controller === active) renderSettings(actual);
  }, 'Device settings saved and verified.');
});
$('refresh').addEventListener('click', () => {
  if ((dirtyEq() || settingsDirty()) && !window.confirm('Read the device again? This discards your local EQ and settings drafts.')) return;
  void task(async () => {
    const active = controller;
    const data = await active.readAll();
    if (controller !== active) return;
    synced = true;
    renderAll(data, active.session.device);
  }, 'Device state refreshed. No settings were written.');
});

function settingsDirty() {
  if (!savedSettings) return false;
  return $('sidetone').checked !== savedSettings.sidetone || Number($('sidetone-level').value) !== savedSettings.sidetoneLevel ||
    Number($('sleep').value) !== savedSettings.sleep || $('dnd').checked !== savedSettings.dnd ||
    (savedSettings.led !== undefined && Number($('led').value) !== savedSettings.led);
}

$('forget').addEventListener('click', () => {
  void task(async () => {
    const device = lastDevice;
    await disconnect('Disconnecting before permission removal.');
    await device.forget();
    lastDevice = null;
  }, 'Device permission removed. A future connection will require the device picker again.');
});
$('tone').addEventListener('click', () => { void audio.tone().catch(error => feedback(`Audio test failed: ${error.message}`, true)); });
$('mic').addEventListener('click', () => { void audio.microphone().catch(error => feedback(`Microphone test failed: ${error.message}`, true)); });
$('stop-audio').addEventListener('click', () => audio.stop());
$('clear-log').addEventListener('click', () => $('activity-log').replaceChildren());

navigator.hid?.addEventListener('disconnect', event => {
  if (event.device === controller?.session.device) {
    void disconnect('USB device removed. Session and audio capture stopped.');
    feedback('Headset disconnected. Some settings may have changed if a write was in progress.', true);
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    void disconnect('Page hidden. Audio stopped and device session closed.');
  } else updateControls();
});
window.addEventListener('pagehide', () => { void disconnect(''); });

const navigationLinks = [...document.querySelectorAll('nav a')];
function markNavigation(target) {
  navigationLinks.forEach(link => {
    if (link.getAttribute('href') === target) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  });
}
window.addEventListener('hashchange', () => markNavigation(window.location.hash || '#overview'));
const sectionObserver = new IntersectionObserver(entries => {
  const visible = entries.find(entry => entry.isIntersecting);
  if (visible) markNavigation(`#${visible.target.id}`);
}, { rootMargin: '-8% 0px -65% 0px' });
navigationLinks.forEach(link => sectionObserver.observe(document.querySelector(link.getAttribute('href'))));
const eqScroller = document.querySelector('.eq-scroll');
const eqResizeObserver = new ResizeObserver(() => {
  $('eq-scroll-hint').hidden = eqScroller.scrollWidth <= eqScroller.clientWidth;
});
eqResizeObserver.observe(eqScroller);

if (!supported) {
  $('compatibility').hidden = false;
  $('compatibility').textContent = !window.isSecureContext
    ? 'Open this app on http://localhost:8080 or HTTPS. WebHID requires a secure context.'
    : 'This browser does not support WebHID. Use desktop Chrome or Edge. You can still explore the demo.';
}
markNavigation(window.location.hash || '#overview');
renderEq(savedEq);
log('Ready. No device access is requested until you click Connect headset.');

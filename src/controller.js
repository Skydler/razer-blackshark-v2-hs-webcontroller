import { decodeEq, encodeEq, integer, PRESETS } from './protocol.js';

function same(actual, expected, name) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${name} read-back did not match. Some settings may have changed. Refresh before retrying.`);
  }
}

export class HeadsetController {
  #session;
  #tail = Promise.resolve();
  #writesEnabled = false;

  constructor(session) { this.#session = session; }
  get session() { return this.#session; }
  set writesEnabled(enabled) { this.#writesEnabled = enabled === true; }

  #run(operation, write = false) {
    const result = this.#tail.then(async () => {
      if (this.#session.closed) throw new Error('Reconnect the headset to continue.');
      if (write && !this.#writesEnabled) throw new Error('Device editing is locked.');
      try {
        return await operation();
      } catch (error) {
        if (write) this.#writesEnabled = false;
        throw error;
      }
    });
    this.#tail = result.catch(() => {});
    return result;
  }

  #read(cmd, domain) { return this.#session.request(cmd, [], domain); }

  async #write(cmd, values, domain) {
    if (!this.#writesEnabled) throw new Error('Device editing is locked.');
    await this.#session.request(cmd, values, domain);
  }

  async #readSettings() {
    const sidetone = (await this.#read(0x18))[0];
    const sidetoneLevel = (await this.#read(0x19))[0];
    const sleep = (await this.#read(0x2c))[0];
    const dnd = (await this.#read(0x27))[0];
    integer(sidetone, 0, 1, 'Reported sidetone state');
    integer(sidetoneLevel, 0, 15, 'Reported sidetone level');
    integer(sleep, 0, 255, 'Reported sleep timer');
    integer(dnd, 0, 1, 'Reported DND state');
    const settings = { sidetone: Boolean(sidetone), sidetoneLevel, sleep, dnd: Boolean(dnd) };
    if (this.#session.device.productId === 0x0565) {
      settings.led = integer((await this.#read(0x66, 0))[0], 0, 3, 'Reported LED mode');
    }
    return settings;
  }

  async #readStatus() {
    const battery = integer((await this.#read(0x21))[0], 0, 100, 'Reported battery');
    const charging = (await this.#read(0x2a))[0] > 0;
    const muted = (await this.#read(0x55))[0] === 1;
    const preset = (await this.#read(0x13))[0];
    if (!Object.hasOwn(PRESETS, preset)) throw new Error('The device reported an unsupported EQ preset.');
    return { battery, charging, muted, preset };
  }

  status() { return this.#run(() => this.#readStatus()); }

  readAll() {
    return this.#run(async () => {
      const serial = (await this.#read(0x00)).filter(v => v >= 32 && v <= 126).map(v => String.fromCharCode(v)).join('');
      const firmware = (await this.#read(0x02)).slice(0, 4).join('.');
      const status = await this.#readStatus();
      const settings = await this.#readSettings();
      const eq = decodeEq(await this.#read(0x15));
      return { serial, firmware, status, settings, eq };
    });
  }

  saveSettings(settings) {
    const desired = {
      sidetone: settings.sidetone,
      sidetoneLevel: integer(settings.sidetoneLevel, 0, 15, 'Sidetone level'),
      sleep: integer(settings.sleep, 0, 255, 'Sleep timer'),
      dnd: settings.dnd,
    };
    if (typeof desired.sidetone !== 'boolean' || typeof desired.dnd !== 'boolean') throw new TypeError('Invalid switch value.');
    if (this.#session.device.productId === 0x0565) desired.led = integer(settings.led, 0, 3, 'LED mode');
    return this.#run(async () => {
      const current = await this.#readSettings();
      const enablingSidetone = desired.sidetone && !current.sidetone;
      const commands = { sidetone: 0x98, sidetoneLevel: 0x99, sleep: 0xac, dnd: 0xa7, led: 0xe6 };
      for (const [key, value] of Object.entries(desired)) {
        // Preserve the controller's enable-then-level sequence, even if the
        // stored level already matches. A stored value need not be latched.
        if (current[key] !== value || (key === 'sidetoneLevel' && enablingSidetone)) {
          await this.#write(commands[key], [Number(value)], key === 'led' ? 0 : undefined);
        }
      }
      const actual = await this.#readSettings();
      same(actual, desired, 'Device settings');
      return actual;
    }, true);
  }

  selectPreset(preset) {
    if (![0, 7, 8, 9].includes(preset)) throw new RangeError('Choose a supported factory preset.');
    return this.#run(async () => {
      await this.#write(0x93, [preset]);
      await this.#write(0x9e, [1]);
      await this.#write(0x9d, [0]);
      same((await this.#read(0x13))[0], preset, 'Preset');
      return { preset, eq: decodeEq(await this.#read(0x15)) };
    }, true);
  }

  saveEq(values) {
    const desired = [...values];
    const wire = encodeEq(desired);
    return this.#run(async () => {
      await this.#write(0x9e, [1]);
      await this.#write(0x9d, [0]);
      await this.#write(0x93, [255]);
      // One curve write per explicit Apply. There is no live-preview write path.
      await this.#write(0x95, wire);
      await new Promise(resolve => setTimeout(resolve, 40));
      await this.#write(0x93, [255]);
      same((await this.#read(0x13))[0], 255, 'Custom preset');
      const actual = decodeEq(await this.#read(0x15));
      same(actual, desired, 'Equalizer');
      return actual;
    }, true);
  }
}

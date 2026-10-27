import { buildReport, isSupportedDevice, parseResponse, REPORT_ID, validateReply } from './protocol.js';

export class HidSession {
  #device;
  #tail = Promise.resolve();
  #pending = null;
  #counter = 0;
  #closed = false;
  #listener;
  #closePromise = null;

  constructor(device, { timeout = 1200, onFault = () => {} } = {}) {
    if (!isSupportedDevice(device) || !device.opened) throw new Error('Open a supported control interface first.');
    this.#device = device;
    this.timeout = timeout;
    this.onFault = onFault;
    this.#listener = event => this.#receive(event);
    device.addEventListener('inputreport', this.#listener);
  }

  get device() { return this.#device; }
  get closed() { return this.#closed; }
  get domain() { return this.#device.productId === 0x0565 ? 0x80 : 0; }

  request(cmd, values = [], domain = this.domain) {
    // Copy and validate before queueing, so later caller mutations cannot alter a packet.
    const bytes = [...values];
    buildReport(cmd, bytes, domain);
    const operation = this.#tail.then(() => this.#send(cmd, bytes, domain));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  #send(cmd, values, domain) {
    if (this.#closed || !this.#device.opened) throw new Error('The device session is closed. Reconnect to continue.');
    const seq = 0x60 | (this.#counter++ & 0x1f);
    const report = buildReport(cmd, values, domain, seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fault(new Error('The device timed out. Reconnect before making more changes.')), this.timeout);
      const pending = { cmd, seq, domain, resolve, reject, timer };
      this.#pending = pending;
      // A hanging send must not prevent timeout or disconnect from settling the request.
      try {
        Promise.resolve(this.#device.sendReport(REPORT_ID, report)).catch(error => {
          if (this.#pending === pending) this.#fault(error);
        });
      } catch (error) {
        this.#fault(error);
      }
    });
  }

  #receive(event) {
    if (this.#closed || !this.#pending || event.device !== this.#device || event.reportId !== REPORT_ID) return;
    try {
      const frame = parseResponse(event.data);
      if (!validateReply(frame, this.#pending)) return;
      const pending = this.#pending;
      this.#pending = null;
      clearTimeout(pending.timer);
      pending.resolve(frame.payload);
    } catch (error) {
      this.#fault(error);
    }
  }

  #fault(error) {
    void this.close(error);
    this.onFault(error);
  }

  close(reason = new Error('The device session was disconnected.')) {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#device.removeEventListener('inputreport', this.#listener);
    if (this.#pending) {
      clearTimeout(this.#pending.timer);
      this.#pending.reject(reason);
      this.#pending = null;
    }
    this.#closePromise = Promise.resolve().then(async () => {
      if (this.#device.opened) await this.#device.close();
    }).catch(() => {}); // A physically removed device may reject close().
    return this.#closePromise;
  }
}

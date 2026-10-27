import { REPORT_ID } from '../src/protocol.js';

export function response({ cmd = 0x21, seq = 0x60, domain = 0x80, status = 1, payload = [84] } = {}) {
  const data = new Uint8Array(63);
  data[1] = seq;
  data[5] = 4 + payload.length;
  data[7] = 0x80;
  data[8] = domain;
  data[9] = cmd;
  data[10] = status;
  data[11] = payload.length;
  data.set(payload, 12);
  for (let i = 0; i < 61; i++) data[61] ^= data[i];
  return data;
}

export class FakeDevice extends EventTarget {
  vendorId = 0x1532;
  productId = 0x0565;
  opened = true;
  collections = [{ usagePage: 0xff14, outputReports: [{ reportId: 2 }], inputReports: [{ reportId: 2 }] }];
  sent = [];
  closes = 0;
  listenerCount = 0;
  onSend = () => {};

  addEventListener(type, callback, options) {
    if (type === 'inputreport') this.listenerCount++;
    super.addEventListener(type, callback, options);
  }

  removeEventListener(type, callback, options) {
    if (type === 'inputreport') this.listenerCount--;
    super.removeEventListener(type, callback, options);
  }

  sendReport(reportId, data) {
    this.sent.push({ reportId, data: new Uint8Array(data) });
    return this.onSend(reportId, data);
  }

  emit(data, { device = this, reportId = REPORT_ID } = {}) {
    const event = new Event('inputreport');
    Object.assign(event, { device, reportId, data: new DataView(data.buffer, data.byteOffset, data.byteLength) });
    this.dispatchEvent(event);
  }

  reply(data, payload = [84]) {
    this.emit(response({ cmd: data[9], seq: data[1], domain: data[8], payload }));
  }

  async close() { this.opened = false; this.closes++; }
}

export const nextTurn = () => new Promise(resolve => setImmediate(resolve));

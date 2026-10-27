// Hardware behavior is experimental.
export const VENDOR_ID = 0x1532;
export const PRODUCT_IDS = Object.freeze([0x0565, 0x056e]);
export const REPORT_ID = 0x02;
export const REPORT_SIZE = 63;
export const FREQUENCIES = Object.freeze(['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']);
export const PRESETS = Object.freeze({ 0x00: 'Flat', 0x07: 'Game', 0x08: 'Music', 0x09: 'Movie', 0xff: 'Custom' });

const READ_LENGTHS = new Map([
  [0x00, 15], [0x02, 4], [0x13, 1], [0x15, 10], [0x18, 1],
  [0x19, 1], [0x21, 1], [0x27, 1], [0x2a, 1], [0x2c, 1], [0x55, 1], [0x66, 1],
]);
const WRITES = new Map([
  [0x93, [1, v => [0, 7, 8, 9, 255].includes(v[0])]],
  [0x95, [10, v => v.every(b => b <= 11 || b >= 252)]],
  [0x98, [1, v => v[0] <= 1]], [0x99, [1, v => v[0] <= 15]],
  [0x9d, [1, v => v[0] === 0]], [0x9e, [1, v => v[0] <= 1]],
  [0xa7, [1, v => v[0] <= 1]], [0xac, [1, () => true]],
  [0xe6, [1, v => v[0] <= 3]],
]);

export function integer(value, min, max, name = 'Value') {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function validateCommand(cmd, values, domain) {
  integer(cmd, 0, 255, 'Command');
  if (domain !== 0 && domain !== 0x80) throw new RangeError('Unsupported command domain.');
  if (!Array.isArray(values)) throw new TypeError('Command data must be an array.');
  values.forEach(v => integer(v, 0, 255, 'Command byte'));
  if (cmd === 0x66 || cmd === 0xe6) {
    if (domain !== 0) throw new RangeError('Dongle commands must use domain 0.');
  }
  if (READ_LENGTHS.has(cmd) && values.length === 0) return;
  const rule = WRITES.get(cmd);
  if (!rule || values.length !== rule[0] || !rule[1](values)) {
    throw new RangeError('Command or payload is outside the supported allowlist.');
  }
}

export function buildReport(cmd, values = [], domain = 0x80, seq = 0x60) {
  validateCommand(cmd, values, domain);
  integer(seq, 0x60, 0x7f, 'Sequence');
  const data = new Uint8Array(REPORT_SIZE);
  data[1] = seq;
  data[5] = 4 + values.length;
  data[8] = domain;
  data[9] = cmd;
  data[11] = values.length;
  data.set(values, 12);
  let checksum = REPORT_ID;
  for (let i = 0; i < 61; i++) checksum ^= data[i];
  data[61] = checksum;
  return data;
}

export function parseResponse(view) {
  if (!ArrayBuffer.isView(view) || view.byteLength !== REPORT_SIZE) {
    throw new Error('Unexpected HID response length.');
  }
  // WebHID provides a DataView; its offset need not be zero.
  const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  // IN and OUT reports use different checksum seeds.
  // Do not accept alternative checksums as a compatibility fallback.
  let checksum = 0;
  for (let i = 0; i < 61; i++) checksum ^= data[i];
  if (checksum !== data[61]) throw new Error('HID response checksum failed.');
  const count = data[11];
  if (count > 48 || data[5] !== 4 + count || data[6] !== 0 || data[62] !== 0) {
    throw new Error('Malformed HID response header.');
  }
  return {
    seq: data[1], domain: data[8], cmd: data[9], status: data[10],
    payload: Array.from(data.slice(12, 12 + count)),
  };
}

export function validateReply(frame, request) {
  if (frame.seq !== request.seq || frame.cmd !== request.cmd || frame.domain !== request.domain) {
    return false;
  }
  if (frame.status !== 1) throw new Error(`The device did not acknowledge command 0x${frame.cmd.toString(16)}.`);
  const minimum = READ_LENGTHS.get(frame.cmd);
  if (minimum !== undefined && frame.payload.length < minimum) {
    throw new Error('The device returned an incomplete setting.');
  }
  return true;
}

export function encodeEq(values) {
  if (!Array.isArray(values) || values.length !== 10) throw new RangeError('EQ requires exactly 10 bands.');
  return values.map(v => (integer(v, -9, 6, 'EQ gain') + 5) & 0xff);
}

export function decodeEq(values) {
  if (!Array.isArray(values) || values.length !== 10) throw new RangeError('Invalid EQ response.');
  return values.map(v => integer(v > 127 ? v - 256 : v, -9, 6, 'Reported EQ gain'));
}

export function isSupportedDevice(device) {
  if (device.vendorId !== VENDOR_ID || !PRODUCT_IDS.includes(device.productId)) return false;
  return (device.collections || []).some(collection =>
    [0xff14, 0xff00].includes(collection.usagePage) &&
    collection.outputReports?.some(report => report.reportId === REPORT_ID) &&
    collection.inputReports?.some(report => report.reportId === REPORT_ID));
}

export function deviceFilters() {
  return PRODUCT_IDS.flatMap(productId => [0xff14, 0xff00].map(usagePage => ({
    vendorId: VENDOR_ID, productId, usagePage,
  })));
}

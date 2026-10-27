import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, decodeEq, deviceFilters, encodeEq, isSupportedDevice, parseResponse, validateReply } from '../src/protocol.js';
import { FakeDevice, response } from './helpers.js';

test('outbound frame has known bytes and report-ID-seeded checksum', () => {
  const actual = buildReport(0x21, [], 0x80, 0x65);
  assert.equal(actual.length, 63);
  assert.deepEqual([...actual.slice(0, 12)], [0, 0x65, 0, 0, 0, 4, 0, 0, 0x80, 0x21, 0, 0]);
  assert.equal(actual[61], 0xc2);
  assert.equal(actual[62], 0);
});

test('rejects unknown commands, oversized data, invalid domains and unsafe values', () => {
  for (const [cmd, values, domain] of [
    [0x42, [], 0x80], [0x21, [1], 0x80], [0x99, [16], 0x80],
    [0x98, [2], 0x80], [0x95, Array(49).fill(0), 0x80],
    [0x95, Array(10).fill(12), 0x80], [0x9d, [1], 0x80],
    [0xe6, [1], 0x80], [0x93, [6], 0], [0xac, [256], 0x80],
    [0x21, [], 1], [0xac, [NaN], 0x80], [0xac, [1.5], 0x80],
  ]) assert.throws(() => buildReport(cmd, values, domain), RangeError);
});

test('EQ encoding preserves signed bounds and rejects malformed gains', () => {
  assert.deepEqual(encodeEq([-9, -8, -6, -5, -4, 0, 1, 2, 5, 6]), [252, 253, 255, 0, 1, 5, 6, 7, 10, 11]);
  assert.deepEqual(decodeEq([247, 248, 250, 251, 252, 0, 1, 2, 5, 6]), [-9, -8, -6, -5, -4, 0, 1, 2, 5, 6]);
  for (const value of [-10, 7, 1.1, NaN, Infinity, '1']) assert.throws(() => encodeEq(Array(10).fill(value)));
  assert.throws(() => encodeEq([0]));
  assert.throws(() => decodeEq(Array(10).fill(7)));
});

test('response parsing respects a nonzero DataView offset', () => {
  const storage = new Uint8Array(90);
  storage.set(response(), 9);
  const frame = parseResponse(new DataView(storage.buffer, 9, 63));
  assert.deepEqual(frame, { seq: 0x60, domain: 0x80, cmd: 0x21, status: 1, payload: [84] });
});

test('rejects malformed responses even if their checksum is valid', () => {
  assert.throws(() => parseResponse(new Uint8Array(62)), /length/);
  const corrupt = response();
  corrupt[12] ^= 1;
  assert.throws(() => parseResponse(corrupt), /checksum/);
  for (const [index, value] of [[5, 1], [6, 1], [11, 49], [62, 1]]) {
    const data = response();
    data[index] = value;
    data[61] = 0;
    for (let i = 0; i < 61; i++) data[61] ^= data[i];
    assert.throws(() => parseResponse(data), /header/);
  }
});

test('correlates command, sequence and domain; rejects NACKs and short reads', () => {
  const frame = parseResponse(response());
  assert.equal(validateReply(frame, frame), true);
  for (const field of ['seq', 'cmd', 'domain']) assert.equal(validateReply(frame, { ...frame, [field]: 255 }), false);
  assert.throws(() => validateReply({ ...frame, status: 0 }, frame), /acknowledge/);
  assert.throws(() => validateReply({ ...frame, payload: [] }, frame), /incomplete/);
});

test('device selection rejects experimental IDs and non-control collections', () => {
  const device = new FakeDevice();
  assert.equal(isSupportedDevice(device), true);
  assert.equal(deviceFilters().length, 4);
  device.productId = 0x0566;
  assert.equal(isSupportedDevice(device), false);
  device.productId = 0x056e;
  device.collections[0].usagePage = 1;
  assert.equal(isSupportedDevice(device), false);
  device.collections[0].usagePage = 0xff00;
  device.collections[0].inputReports = [];
  assert.equal(isSupportedDevice(device), false);
});

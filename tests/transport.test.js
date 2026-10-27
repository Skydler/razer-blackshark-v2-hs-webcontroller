import test from 'node:test';
import assert from 'node:assert/strict';
import { HidSession } from '../src/transport.js';
import { FakeDevice, nextTurn, response } from './helpers.js';

test('serializes traffic and ignores replies for other requests or devices', async t => {
  const device = new FakeDevice();
  const session = new HidSession(device);
  t.after(() => session.close());
  const first = session.request(0x21);
  const second = session.request(0x55);
  await nextTurn();
  assert.equal(device.sent.length, 1);
  device.emit(response({ domain: 0 }));
  device.emit(response(), { device: new FakeDevice() });
  device.emit(response(), { reportId: 1 });
  device.emit(response({ seq: 0x61 }));
  await nextTurn();
  assert.equal(device.sent.length, 1);
  device.reply(device.sent[0].data, [84]);
  assert.deepEqual(await first, [84]);
  await nextTurn();
  assert.equal(device.sent.length, 2);
  device.reply(device.sent[1].data, [0]);
  assert.deepEqual(await second, [0]);
});

test('disconnect rejects active and queued requests and removes the listener', async () => {
  const device = new FakeDevice();
  const session = new HidSession(device);
  const active = assert.rejects(session.request(0x21), /disconnected/);
  const queued = assert.rejects(session.request(0x55), /closed/);
  await nextTurn();
  await session.close();
  await Promise.all([active, queued]);
  assert.equal(device.sent.length, 1);
  assert.equal(device.listenerCount, 0);
  assert.equal(device.closes, 1);
  await session.close();
  assert.equal(device.closes, 1);
});

test('a hanging send times out and closes the session without retries', async () => {
  const device = new FakeDevice();
  device.onSend = () => new Promise(() => {});
  const faults = [];
  const session = new HidSession(device, { timeout: 15, onFault: error => faults.push(error) });
  await assert.rejects(session.request(0x21), /timed out/);
  await session.close();
  await assert.rejects(session.request(0x21), /closed/);
  assert.equal(device.sent.length, 1);
  assert.equal(faults.length, 1);
});

test('checksum faults and negative acknowledgements fail closed', async () => {
  for (const malformed of [true, false]) {
    const device = new FakeDevice();
    const session = new HidSession(device);
    const rejected = assert.rejects(session.request(0x21), malformed ? /checksum/ : /acknowledge/);
    await nextTurn();
    const data = response({ status: malformed ? 1 : 0 });
    if (malformed) data[61] ^= 1;
    device.emit(data);
    await rejected;
    assert.equal(session.closed, true);
    await session.close();
  }
});

test('wire transport uses domain zero and input payloads are copied before queueing', async t => {
  const device = new FakeDevice();
  device.productId = 0x056e;
  const session = new HidSession(device);
  t.after(() => session.close());
  device.onSend = (_, data) => device.reply(data, []);
  const values = [10];
  const request = session.request(0x99, values);
  values[0] = 255;
  await request;
  assert.equal(device.sent[0].data[8], 0);
  assert.equal(device.sent[0].data[12], 10);
});

test('late send rejection cannot cancel a new transaction after sequence wrap', async t => {
  const device = new FakeDevice();
  const session = new HidSession(device);
  t.after(() => session.close());
  let rejectOld;
  device.onSend = (_, data) => {
    if (device.sent.length === 1) {
      device.reply(data);
      return new Promise((_, reject) => { rejectOld = reject; });
    }
    if (device.sent.length <= 32) device.reply(data);
  };
  for (let i = 0; i < 32; i++) await session.request(0x21);
  const latest = session.request(0x21);
  await nextTurn();
  rejectOld(new Error('Late send rejection'));
  await nextTurn();
  assert.equal(session.closed, false);
  device.reply(device.sent.at(-1).data);
  assert.deepEqual(await latest, [84]);
});

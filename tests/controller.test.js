import test from 'node:test';
import assert from 'node:assert/strict';
import { HeadsetController } from '../src/controller.js';

class FakeSession {
  device = { productId: 0x0565 };
  closed = false;
  calls = [];
  registers = new Map([
    [0x18, [0]], [0x19, [10]], [0x2c, [15]], [0x27, [0]], [0x66, [1]],
    [0x13, [8]], [0x15, Array(10).fill(0)], [0x21, [84]], [0x2a, [0]], [0x55, [0]],
    [0x00, Array(15).fill(65)], [0x02, [1, 2, 3, 4]],
  ]);
  failOn = null;
  ignoreWrites = false;

  async request(cmd, values = [], domain) {
    this.calls.push({ cmd, values, domain });
    if (this.closed) throw new Error('Closed');
    if (cmd === this.failOn) throw new Error('Injected device failure');
    if (!values.length) return this.registers.get(cmd);
    if (!this.ignoreWrites) {
      if (cmd === 0x95) this.registers.set(0x15, values.map(v => (v - 5) & 255));
      else this.registers.set(cmd & 0x7f, [...values]);
    }
    return [];
  }
}

test('initial synchronization is read-only and edits require explicit unlocking', async () => {
  const session = new FakeSession();
  const controller = new HeadsetController(session);
  const state = await controller.readAll();
  assert.equal(state.status.battery, 84);
  assert.equal(session.calls.every(call => call.values.length === 0), true);
  await assert.rejects(controller.saveEq(Array(10).fill(0)), /locked/);
  assert.equal(session.calls.every(call => call.values.length === 0), true);
});

test('save writes only changed settings and verifies the complete result', async () => {
  const session = new FakeSession();
  const controller = new HeadsetController(session);
  controller.writesEnabled = true;
  const desired = { sidetone: false, sidetoneLevel: 10, sleep: 30, dnd: false, led: 1 };
  assert.deepEqual(await controller.saveSettings(desired), desired);
  assert.deepEqual(session.calls.filter(call => call.values.length), [{ cmd: 0xac, values: [30], domain: undefined }]);
});

test('enabling sidetone reapplies an unchanged level after the enable command', async () => {
  const session = new FakeSession();
  session.registers.set(0x19, [12]);
  const controller = new HeadsetController(session);
  controller.writesEnabled = true;
  const desired = { sidetone: true, sidetoneLevel: 12, sleep: 15, dnd: false, led: 1 };
  assert.deepEqual(await controller.saveSettings(desired), desired);
  assert.deepEqual(session.calls.filter(call => call.values.length).map(({ cmd, values }) => ({ cmd, values })), [
    { cmd: 0x98, values: [1] }, { cmd: 0x99, values: [12] },
  ]);
});

test('enabling sidetone with a new level writes that level only once', async () => {
  const session = new FakeSession();
  const controller = new HeadsetController(session);
  controller.writesEnabled = true;
  await controller.saveSettings({ sidetone: true, sidetoneLevel: 12, sleep: 15, dnd: false, led: 1 });
  assert.deepEqual(session.calls.filter(call => call.values.length).map(call => call.cmd), [0x98, 0x99]);
});

test('saving another setting does not reapply an already-enabled sidetone', async () => {
  const session = new FakeSession();
  session.registers.set(0x18, [1]);
  const controller = new HeadsetController(session);
  controller.writesEnabled = true;
  await controller.saveSettings({ sidetone: true, sidetoneLevel: 10, sleep: 30, dnd: false, led: 1 });
  assert.deepEqual(session.calls.filter(call => call.values.length).map(call => call.cmd), [0xac]);
});

test('disabling sidetone does not rewrite an unchanged level', async () => {
  const session = new FakeSession();
  session.registers.set(0x18, [1]);
  const controller = new HeadsetController(session);
  controller.writesEnabled = true;
  await controller.saveSettings({ sidetone: false, sidetoneLevel: 10, sleep: 15, dnd: false, led: 1 });
  assert.deepEqual(session.calls.filter(call => call.values.length).map(({ cmd, values }) => ({ cmd, values })), [
    { cmd: 0x98, values: [0] },
  ]);
});

test('a failed sidetone level write prevents unrelated writes and locks editing', async () => {
  const session = new FakeSession();
  session.failOn = 0x99;
  const controller = new HeadsetController(session);
  controller.writesEnabled = true;
  const desired = { sidetone: true, sidetoneLevel: 10, sleep: 30, dnd: false, led: 1 };
  await assert.rejects(controller.saveSettings(desired), /Injected device failure/);
  assert.deepEqual(session.calls.filter(call => call.values.length).map(call => call.cmd), [0x98, 0x99]);
  await assert.rejects(controller.saveSettings(desired), /locked/);
});

test('custom EQ writes the curve once and latches it before read-back', async () => {
  const session = new FakeSession();
  const controller = new HeadsetController(session);
  controller.writesEnabled = true;
  const values = [-9, -8, -4, 0, 1, 2, 3, 4, 5, 6];
  assert.deepEqual(await controller.saveEq(values), values);
  assert.deepEqual(session.calls.map(call => call.cmd), [0x9e, 0x9d, 0x93, 0x95, 0x93, 0x13, 0x15]);
  assert.equal(session.calls.filter(call => call.cmd === 0x95).length, 1);
});

test('factory preset selection leaves the saved custom curve alone', async () => {
  const session = new FakeSession();
  const controller = new HeadsetController(session);
  controller.writesEnabled = true;
  await controller.selectPreset(8);
  assert.equal(session.calls.some(call => call.cmd === 0x95), false);
  assert.throws(() => controller.selectPreset(255));
});

test('read-back mismatch locks editing and does not report success or retry', async () => {
  const session = new FakeSession();
  session.ignoreWrites = true;
  const controller = new HeadsetController(session);
  controller.writesEnabled = true;
  await assert.rejects(controller.saveEq(Array(10).fill(2)), /read-back did not match/);
  await assert.rejects(controller.selectPreset(8), /locked/);
  assert.equal(session.calls.filter(call => call.cmd === 0x95).length, 1);
});

test('a failed write sequence stops immediately, without later writes or rollback', async () => {
  const session = new FakeSession();
  session.failOn = 0x95;
  const controller = new HeadsetController(session);
  controller.writesEnabled = true;
  await assert.rejects(controller.saveEq(Array(10).fill(0)), /Injected/);
  assert.deepEqual(session.calls.map(call => call.cmd), [0x9e, 0x9d, 0x93, 0x95]);
});

test('queued edits cannot run after the session is locked', async () => {
  const session = new FakeSession();
  const controller = new HeadsetController(session);
  controller.writesEnabled = true;
  const write = controller.selectPreset(8);
  controller.writesEnabled = false;
  await assert.rejects(write, /locked/);
  assert.equal(session.calls.length, 0);
});

test('wired settings never read or write the dongle LED', async () => {
  const session = new FakeSession();
  session.device.productId = 0x056e;
  const controller = new HeadsetController(session);
  controller.writesEnabled = true;
  await controller.saveSettings({ sidetone: false, sidetoneLevel: 10, sleep: 15, dnd: false });
  assert.equal(session.calls.some(call => [0x66, 0xe6].includes(call.cmd)), false);
});

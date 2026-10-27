import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioTools } from '../src/audio.js';

function globalValue(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}

function fakeStream() {
  const track = new EventTarget();
  track.label = 'Test input';
  track.stops = 0;
  track.stop = () => { track.stops++; };
  return { getTracks: () => [track], getAudioTracks: () => [track], track };
}

test('stops a late microphone permission result after cancellation', async t => {
  let resolveStream;
  globalValue(t, 'navigator', { mediaDevices: { getUserMedia: () => new Promise(resolve => { resolveStream = resolve; }) } });
  const audio = new AudioTools();
  const starting = audio.microphone();
  assert.equal(audio.active, true);
  audio.stop();
  const stream = fakeStream();
  resolveStream(stream);
  await starting;
  assert.equal(stream.track.stops, 1);
  assert.equal(audio.active, false);
});

test('setup failure stops all acquired tracks and closes the audio context', async t => {
  const stream = fakeStream();
  let closes = 0;
  globalValue(t, 'navigator', { mediaDevices: { getUserMedia: async () => stream } });
  globalValue(t, 'AudioContext', class {
    createMediaStreamSource() { throw new Error('Audio setup failed'); }
    async close() { closes++; }
  });
  const audio = new AudioTools();
  await assert.rejects(audio.microphone(), /Audio setup failed/);
  assert.equal(stream.track.stops, 1);
  assert.equal(closes, 1);
  assert.equal(audio.active, false);
});

test('permission timeout invalidates a stream that arrives later', async t => {
  let timeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => {
    assert.equal(delay, 30_000);
    timeout = callback;
    return 1;
  });
  t.mock.method(globalThis, 'clearTimeout', () => {});
  let resolveStream;
  globalValue(t, 'navigator', { mediaDevices: { getUserMedia: () => new Promise(resolve => { resolveStream = resolve; }) } });
  const audio = new AudioTools();
  const starting = audio.microphone();
  timeout();
  const stream = fakeStream();
  resolveStream(stream);
  await starting;
  assert.equal(stream.track.stops, 1);
  assert.equal(audio.active, false);
});

test('active microphone is meter-only and stop releases tracks, context and animation', async t => {
  const stream = fakeStream();
  let closes = 0;
  let cancels = 0;
  const connections = [];
  const analyser = { fftSize: 0, getByteTimeDomainData: data => data.fill(128) };
  globalValue(t, 'navigator', { mediaDevices: { getUserMedia: async () => stream } });
  globalValue(t, 'AudioContext', class {
    destination = { speaker: true };
    createMediaStreamSource() { return { connect: node => connections.push(node) }; }
    createAnalyser() { return analyser; }
    async resume() {}
    async close() { closes++; }
  });
  globalValue(t, 'requestAnimationFrame', () => 5);
  globalValue(t, 'cancelAnimationFrame', () => { cancels++; });
  const audio = new AudioTools();
  await audio.microphone();
  assert.deepEqual(connections, [analyser]);
  audio.stop();
  assert.equal(stream.track.stops, 1);
  assert.equal(closes, 1);
  assert.equal(cancels, 1);
  assert.equal(audio.active, false);
});

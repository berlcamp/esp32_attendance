import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Backoff } from '../backoff.ts';
import { waitFor } from '../test-helpers.ts';
import { Camera, ffmpegArgs } from './camera.ts';

// Stands in for ffmpeg: writes a JPEG-shaped frame every 50 ms, then exits
// after `frames` of them.
const fakeFfmpeg = (frames: number) => [
  '-e',
  `let i = 0; const t = setInterval(() => {
     process.stdout.write(Buffer.from([0xff, 0xd8, i, 0xff, 0xd9]));
     if (++i >= ${frames}) { clearInterval(t); process.exit(1); }
   }, 50);`,
];

test('ffmpegArgs reads MJPEG from v4l2 on Linux and avfoundation on the Mac', () => {
  const linux = ffmpegArgs('/dev/video0', 'linux');
  assert.deepEqual(linux.slice(linux.indexOf('-f'), linux.indexOf('-f') + 4), ['-f', 'v4l2', '-input_format', 'mjpeg']);
  assert.equal(linux[linux.indexOf('-i') + 1], '/dev/video0');
  const mac = ffmpegArgs('CyberTrack H3', 'darwin');
  assert.ok(mac.includes('avfoundation'));
  assert.equal(mac[mac.indexOf('-i') + 1], 'CyberTrack H3');
  assert.equal(mac.at(-1), 'pipe:1');
});

test('the newest frame is the snapshot, and the camera restarts after ffmpeg exits', async () => {
  const logs: string[] = [];
  const cam = new Camera({
    device: 'fake', log: (l) => logs.push(l), command: process.execPath, args: fakeFfmpeg(3),
    backoff: new Backoff(50, 50),
  });
  assert.equal(cam.snapshot(), null);
  cam.start();
  try {
    await waitFor(() => cam.snapshot() !== null);
    assert.equal(cam.online, true);
    assert.deepEqual(cam.snapshot()!.subarray(0, 2), Buffer.from([0xff, 0xd8]));
    await waitFor(() => logs.filter((l) => l.includes('streaming')).length >= 2, 3000);
    assert.ok(logs.some((l) => l.includes('stopped')), logs.join('\n'));
  } finally {
    cam.stop();
  }
});

test('a stale frame is not a snapshot', async () => {
  let now = 1_000_000;
  const cam = new Camera({
    device: 'fake', log: () => {}, command: process.execPath, args: fakeFfmpeg(1000),
    backoff: new Backoff(60_000, 60_000), now: () => now,
  });
  cam.start();
  try {
    await waitFor(() => cam.snapshot() !== null);
    now += 2000; // the clock moves on; no new frame arrives in between
    assert.equal(cam.snapshot(), null);
    assert.equal(cam.online, false);
  } finally {
    cam.stop();
  }
});

test('a missing ffmpeg is logged and retried, never thrown', async () => {
  const logs: string[] = [];
  const cam = new Camera({
    device: 'fake', log: (l) => logs.push(l), command: '/nonexistent/ffmpeg', args: [],
    backoff: new Backoff(20, 20),
  });
  cam.start();
  try {
    await waitFor(() => logs.filter((l) => l.includes('stopped')).length >= 2);
    assert.match(logs[0], /ENOENT/);
  } finally {
    cam.stop();
  }
});

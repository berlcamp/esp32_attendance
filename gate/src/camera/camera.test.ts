import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Backoff } from '../backoff.ts';
import { waitFor } from '../test-helpers.ts';
import { Camera, ffmpegArgs } from './camera.ts';

// Stands in for ffmpeg: writes a JPEG-shaped frame to each output (stdout
// for the kiosk, fd 3 for the upload) every 50 ms, then exits after `frames`.
const fakeFfmpeg = (frames: number) => [
  '-e',
  `let i = 0; const t = setInterval(() => {
     process.stdout.write(Buffer.from([0xff, 0xd8, 1, i, 0xff, 0xd9]));
     require('node:fs').writeSync(3, Buffer.from([0xff, 0xd8, 3, i, 0xff, 0xd9]));
     if (++i >= ${frames}) { clearInterval(t); process.exit(1); }
   }, 50);`,
];

test('ffmpegArgs reads 720p MJPEG and writes a sharp kiosk picture and a small upload', () => {
  const linux = ffmpegArgs('/dev/video0', 'linux');
  assert.deepEqual(linux.slice(linux.indexOf('-f'), linux.indexOf('-f') + 4), ['-f', 'v4l2', '-input_format', 'mjpeg']);
  assert.equal(linux[linux.indexOf('-i') + 1], '/dev/video0');
  const mac = ffmpegArgs('CyberTrack H3', 'darwin');
  assert.ok(mac.includes('avfoundation'));
  assert.equal(mac[mac.indexOf('-i') + 1], 'CyberTrack H3');
  assert.equal(linux[linux.indexOf('-video_size') + 1], '1280x720');
  assert.equal(linux[linux.indexOf('pipe:1') - 3], '2', 'kiosk at q 2');
  assert.match(linux[linux.indexOf('-filter_complex') + 1], /scale=640:-2/);
  assert.equal(linux.at(-1), 'pipe:3');
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
    const snap = cam.snapshot()!;
    assert.equal(snap.kiosk[2], 1, 'the kiosk picture comes from stdout');
    assert.equal(snap.upload[2], 3, 'the upload picture comes from fd 3');
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

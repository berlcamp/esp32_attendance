import { spawn, type ChildProcess } from 'node:child_process';
import { Backoff } from '../backoff.ts';
import type { Log } from '../log.ts';
import { JpegSplitter } from './jpeg.ts';

// A frame older than this is a stalled camera, not a picture of who just
// tapped. Better no photo than someone else's.
export const MAX_FRAME_AGE_MS = 1500;
// ffmpeg alive but silent this long (a camera pulled mid-stream can do that)
// is killed, and the normal restart takes over.
export const STALL_MS = 10_000;

// One frame, two pictures: a sharp one for the kiosk monitor and a small one
// for the upload, which is what the parent's Telegram message carries. Small
// is what makes it fast: the upload, the bucket and Telegram's own fetch all
// move ~40 KB instead of ~200 KB.
export interface Snapshot {
  kiosk: Buffer;
  upload: Buffer;
}

// The camera streams continuously and the newest frames are kept in memory,
// so a tap is photographed in zero time. Opening a UVC camera per tap takes a
// second or more, and the first frames are dark while exposure settles.
export function ffmpegArgs(device: string, platform: NodeJS.Platform = process.platform): string[] {
  const input =
    platform === 'darwin'
      ? // Development on the Mac: a device name ("CyberTrack H3") or index.
        ['-f', 'avfoundation', '-framerate', '30', '-video_size', '1280x720', '-pixel_format', 'uyvy422', '-i', device]
      : // The mini PC: the UVC camera's own MJPEG, so the USB link and the CPU
        // carry compressed frames.
        ['-f', 'v4l2', '-input_format', 'mjpeg', '-video_size', '1280x720', '-framerate', '15', '-i', device];
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...input,
    // 5 fps keeps a frame at most 200 ms old for little CPU; split makes both
    // pictures from the same frame, so the kiosk and the parent see one moment.
    '-filter_complex', '[0:v]fps=5,split=2[kiosk][up];[up]scale=640:-2:flags=lanczos[small]',
    // Re-encoded rather than copied: UVC MJPEG often omits its Huffman tables,
    // which browsers and Telegram do not all accept. q 2 is near-lossless.
    '-map', '[kiosk]', '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', 'pipe:1',
    // 640 wide fills a phone screen in a Telegram chat; q 6 keeps it ~40 KB.
    '-map', '[small]', '-c:v', 'mjpeg', '-q:v', '6', '-f', 'image2pipe', 'pipe:3',
  ];
}

export interface CameraOptions {
  device: string;
  log: Log;
  command?: string;
  args?: string[];
  backoff?: Backoff;
  now?: () => number;
}

export class Camera {
  #o: Required<CameraOptions>;
  #child: ChildProcess | null = null;
  #kiosk: Buffer | null = null;
  #upload: Buffer | null = null;
  #kioskAt = 0;
  #uploadAt = 0;
  #stopped = true;
  #restart: NodeJS.Timeout | null = null;
  #watchdog: NodeJS.Timeout | null = null;
  #lastOutput = 0;
  #onStatus: () => void = () => {};
  #wasOnline = false;

  constructor(opts: CameraOptions) {
    this.#o = {
      command: 'ffmpeg',
      args: ffmpegArgs(opts.device),
      backoff: new Backoff(2000, 60_000),
      now: () => Date.now(),
      ...opts,
    };
  }

  onStatus(handler: () => void): void {
    this.#onStatus = handler;
  }

  // "Online" is what matters at the gate: fresh frames, not a live process.
  get online(): boolean {
    const now = this.#o.now();
    return (
      this.#kiosk !== null && this.#upload !== null &&
      now - this.#kioskAt <= MAX_FRAME_AGE_MS && now - this.#uploadAt <= MAX_FRAME_AGE_MS
    );
  }

  // The newest pair of pictures if both are fresh, else null.
  snapshot(): Snapshot | null {
    return this.online ? { kiosk: this.#kiosk!, upload: this.#upload! } : null;
  }

  start(): void {
    this.#stopped = false;
    this.#spawn();
    this.#watchdog = setInterval(() => {
      this.#statusChanged();
      if (this.#child && this.#o.now() - this.#lastOutput > STALL_MS) {
        this.#o.log(`[camera] no frame for ${STALL_MS / 1000} s -- restarting ffmpeg`);
        this.#child.kill('SIGKILL');
      }
    }, 1000);
    this.#watchdog.unref();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#restart) clearTimeout(this.#restart);
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#child?.kill('SIGTERM');
    this.#child = null;
  }

  #spawn(): void {
    const { command, args, log, backoff, device } = this.#o;
    const kiosk = new JpegSplitter();
    const upload = new JpegSplitter();
    let stderr = '';
    let gotFrame = false;
    // fd 3 is the second output (pipe:3), the small picture.
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    this.#child = child;
    this.#lastOutput = this.#o.now();

    const frame = (): void => {
      this.#lastOutput = this.#o.now();
      if (!gotFrame && this.#kiosk && this.#upload) {
        gotFrame = true;
        backoff.onSuccess();
        log(`[camera] streaming from ${device}`);
      }
      this.#statusChanged();
    };
    child.stdout!.on('data', (chunk: Buffer) => {
      const frames = kiosk.push(chunk);
      if (frames.length === 0) return;
      this.#kiosk = frames.at(-1)!;
      this.#kioskAt = this.#o.now();
      frame();
    });
    (child.stdio[3] as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
      const frames = upload.push(chunk);
      if (frames.length === 0) return;
      this.#upload = frames.at(-1)!;
      this.#uploadAt = this.#o.now();
      frame();
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-500);
    });
    // 'error' (ffmpeg not installed) is followed by 'close', which restarts.
    child.on('error', (err) => {
      stderr = err.message;
    });
    child.on('close', (code, signal) => {
      if (this.#child === child) this.#child = null;
      this.#kiosk = this.#upload = null;
      this.#statusChanged();
      if (this.#stopped) return;
      backoff.onFailure();
      log(
        `[camera] ${device} stopped (code=${code ?? signal}); retry in ${backoff.delayMs} ms` +
          (stderr.trim() ? `: ${stderr.trim().split('\n').at(-1)}` : ''),
      );
      this.#restart = setTimeout(() => this.#spawn(), backoff.delayMs);
    });
  }

  #statusChanged(): void {
    const online = this.online;
    if (online === this.#wasOnline) return;
    this.#wasOnline = online;
    this.#onStatus();
  }
}

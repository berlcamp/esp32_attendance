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

// The camera streams continuously and the newest frame is kept in memory, so
// a tap is photographed in zero time. Opening a UVC camera per tap takes a
// second or more, and the first frames are dark while exposure settles.
export function ffmpegArgs(device: string, platform: NodeJS.Platform = process.platform): string[] {
  const input =
    platform === 'darwin'
      ? // Development on the Mac: a device name ("CyberTrack H3") or index.
        ['-f', 'avfoundation', '-framerate', '30', '-video_size', '640x480', '-pixel_format', 'uyvy422', '-i', device]
      : // The mini PC: the UVC camera's own MJPEG, so the USB link and the CPU
        // carry compressed frames.
        ['-f', 'v4l2', '-input_format', 'mjpeg', '-video_size', '640x480', '-framerate', '15', '-i', device];
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    ...input,
    // Re-encoded rather than copied: UVC MJPEG often omits its Huffman tables,
    // which browsers and Telegram do not all accept. 5 fps keeps a frame at
    // most 200 ms old for next to no CPU.
    '-vf', 'fps=5', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:1',
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
  #frame: Buffer | null = null;
  #frameAt = 0;
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

  // "Online" is what matters at the gate: a fresh frame, not a live process.
  get online(): boolean {
    return this.#frame !== null && this.#o.now() - this.#frameAt <= MAX_FRAME_AGE_MS;
  }

  // The newest frame if it is fresh, else null.
  snapshot(): Buffer | null {
    return this.online ? this.#frame : null;
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
    const splitter = new JpegSplitter();
    let stderr = '';
    let gotFrame = false;
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.#child = child;
    this.#lastOutput = this.#o.now();

    child.stdout.on('data', (chunk: Buffer) => {
      const frames = splitter.push(chunk);
      if (frames.length === 0) return;
      this.#frame = frames.at(-1)!;
      this.#frameAt = this.#lastOutput = this.#o.now();
      if (!gotFrame) {
        gotFrame = true;
        backoff.onSuccess();
        log(`[camera] streaming from ${device}`);
      }
      this.#statusChanged();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-500);
    });
    // 'error' (ffmpeg not installed) is followed by 'close', which restarts.
    child.on('error', (err) => {
      stderr = err.message;
    });
    child.on('close', (code, signal) => {
      if (this.#child === child) this.#child = null;
      this.#frame = null;
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

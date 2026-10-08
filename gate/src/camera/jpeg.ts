// ffmpeg writes the camera as back-to-back JPEGs on one pipe (image2pipe).
// This cuts that byte stream into whole frames: SOI (FF D8) to EOI (FF D9).
// ffmpeg's own mjpeg encoder writes no EXIF thumbnail, so the first EOI after
// an SOI is the end of the frame.
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
// A frame larger than this means the stream is corrupt, not a big picture;
// dropping the buffer stops it growing without bound.
const MAX_FRAME = 4 * 1024 * 1024;

export class JpegSplitter {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const frames: Buffer[] = [];
    for (;;) {
      const start = this.#buf.indexOf(SOI);
      if (start < 0) {
        // Keep a trailing FF: it may be the first half of the next SOI.
        this.#buf = this.#buf.at(-1) === 0xff ? this.#buf.subarray(-1) : Buffer.alloc(0);
        break;
      }
      const end = this.#buf.indexOf(EOI, start + 2);
      if (end < 0) {
        this.#buf = this.#buf.subarray(start);
        if (this.#buf.length > MAX_FRAME) this.#buf = Buffer.alloc(0);
        break;
      }
      frames.push(Buffer.from(this.#buf.subarray(start, end + 2)));
      this.#buf = this.#buf.subarray(end + 2);
    }
    return frames;
  }
}

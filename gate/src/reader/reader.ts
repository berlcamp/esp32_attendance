// Port of src/TagReader.h. Everything downstream only ever sees a uid string,
// so the evdev, keyboard and simulated readers are interchangeable.
// inject() and injectBurst() live on the base, not the subclasses, so
// `scan <uid>` and `burst <n>` behave the same against real hardware -- they
// are how the upload path is tested without a card.
export type CardHandler = (uid: string) => void;
export type StatusHandler = (online: boolean) => void;

export abstract class TagReader {
  #enabled = true;
  #online = false;
  #burstSeq = 1;
  #onCard: CardHandler = () => {};
  #onStatus: StatusHandler = () => {};

  abstract start(): void;
  abstract stop(): void;

  onCard(handler: CardHandler): void {
    this.#onCard = handler;
  }

  onStatus(handler: StatusHandler): void {
    this.#onStatus = handler;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setEnabled(on: boolean): void {
    this.#enabled = on;
  }

  get online(): boolean {
    return this.#online;
  }

  // Injected scans bypass the enable switch, exactly as the firmware's did.
  inject(uid: string): void {
    this.#onCard(uid);
  }

  // Synthetic unique uids: reusing real ones would trip the cooldown. The
  // server keeps ^B[0-9]{7}$ off the enrolment queue.
  injectBurst(n: number): void {
    for (let i = 0; i < n; i++) this.#onCard(`B${String(this.#burstSeq++).padStart(7, '0')}`);
  }

  protected emit(uid: string): void {
    if (this.#enabled) this.#onCard(uid);
  }

  protected setOnline(online: boolean): void {
    if (online === this.#online) return;
    this.#online = online;
    this.#onStatus(online);
  }
}

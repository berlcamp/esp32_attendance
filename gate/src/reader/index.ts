import type { Config } from '../config.ts';
import type { Log } from '../log.ts';
import { EvdevReader } from './evdev.ts';
import { KeyboardReader } from './keyboard.ts';
import type { TagReader } from './reader.ts';
import { SimulatedReader } from './simulated.ts';

export function createReader(config: Config, log: Log): TagReader {
  switch (config.reader) {
    case 'evdev':
      return new EvdevReader(config.readerDevice ?? '', log);
    case 'keyboard':
      return new KeyboardReader(log);
    case 'simulated':
      return new SimulatedReader();
  }
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { PAGE_HTML } from './page.ts';

// Runs the page's inline script against a minimal fake DOM, EventSource and
// timer, so the screen's behaviour can be tested without a browser.
function loadPage() {
  const script = /<script>([\s\S]*)<\/script>/.exec(PAGE_HTML.replaceAll('{{VERSION}}', 'v1'))![1];
  const els = new Map<string, { textContent: string; className: string; replaceChildren: () => void }>();
  const el = (id: string) => {
    if (!els.has(id)) els.set(id, { textContent: '', className: '', replaceChildren: () => {} });
    return els.get(id)!;
  };
  let source: { onmessage: (m: { data: string }) => void } | null = null;
  const timers: { fn: () => void; ms: number }[] = [];
  runInNewContext(script, {
    document: { getElementById: el, createElement: () => ({ className: '', textContent: '' }) },
    EventSource: class { constructor() { source = this as never; } },
    location: { reload: () => {} },
    setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id: number) => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
    setInterval: () => 0,
    Date,
  });
  const send = (e: unknown) => source!.onmessage({ data: JSON.stringify(e) });
  const text = (id: string) => el(id).textContent;
  return { send, text, timers, el };
}

const JUAN = { student_id: 'st1', full_name: 'Dela Cruz, Juan', student_no: '2026-0001', grade_level: 'Grade 7', section_name: 'Rizal' };
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

test('the screen starts on the default message', () => {
  const { text } = loadPage();
  assert.equal(text('status'), 'Please tap your card');
  assert.equal(text('name'), '');
});

test('a tap shows the student, and 1 minute later the default message returns', () => {
  const { send, text, timers, el } = loadPage();
  send({ type: 'scan', uid: '0002008108', at: ago(0), student: JUAN });
  assert.equal(text('name'), 'Dela Cruz, Juan');
  assert.equal(text('initials'), 'JD');
  assert.equal(el('card').className, 'known');
  const idle = timers.at(-1)!;
  assert.ok(idle.ms > 59_000 && idle.ms <= 60_000, `idle timer ${idle.ms} ms`);
  idle.fn();
  assert.equal(text('status'), 'Please tap your card');
  assert.equal(text('name'), '');
  assert.equal(text('details'), '');
  assert.equal(text('meta'), '');
  assert.equal(text('initials'), '');
  assert.equal(el('card').className, 'idle');
});

test('a new tap restarts the 1 minute, so an earlier timer cannot clear it', () => {
  const { send, text, timers } = loadPage();
  send({ type: 'scan', uid: '0002008108', at: ago(0), student: JUAN });
  const first = timers.at(-1)!;
  send({ type: 'scan', uid: '0000000001', at: ago(0), student: null });
  first.fn();
  assert.equal(text('status'), 'Unknown card');
});

test('a tap older than 1 minute (replayed after a browser restart) is not shown', () => {
  const { send, text } = loadPage();
  send({ type: 'scan', uid: '0002008108', at: ago(2 * 60_000), student: JUAN });
  assert.equal(text('status'), 'Please tap your card');
  assert.equal(text('name'), '');
});

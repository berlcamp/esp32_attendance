import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSse, type GateEvent } from './sse.ts';

test('an SSE frame is one data line and a blank line', () => {
  const e: GateEvent = { type: 'scan', uid: '0002008108', at: '2026-10-05T07:00:00.000Z', student: null, photo: null };
  assert.equal(formatSse(e), `data: ${JSON.stringify(e)}\n\n`);
});

test('the scan payload carries exactly what the page renders', () => {
  const e: GateEvent = {
    type: 'scan', uid: '0002008108', at: '2026-10-05T07:00:00.000Z',
    student: { student_id: 'st1', full_name: 'Dela Cruz, Juan', student_no: '2026-0001', grade_level: 'Grade 7', section_name: 'Rizal' },
    photo: '/captures/e1.jpg',
  };
  const parsed = JSON.parse(formatSse(e).slice('data: '.length));
  assert.deepEqual(Object.keys(parsed).sort(), ['at', 'photo', 'student', 'type', 'uid']);
  assert.equal(parsed.uid, '0002008108');
});

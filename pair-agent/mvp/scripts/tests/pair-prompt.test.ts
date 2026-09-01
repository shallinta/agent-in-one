import { expect, test } from 'vitest';

import { P05_PAIR_PROMPT } from '../pair-prompt.js';

test('defines the P0.5 Pair Contract without claiming P1 controls', () => {
  const text = P05_PAIR_PROMPT.commonSystem.content;
  const sections = [
    'PAIR SESSION IDENTITY',
    'USER AUTHORITY AND ROLE CATALOG',
    'SHARED CONTEXT AND EVENT INTERPRETATION',
    'COMMUNICATION AND RESPONSE OWNERSHIP',
    'ACTIVE ROLE REMINDER PROTOCOL',
    'P0.5 CAPABILITY BOUNDARY',
  ];
  const positions = sections.map((section) => text.indexOf(section));
  expect(positions.every((position) => position >= 0)).toBe(true);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(text).toContain('The user is the only authority');
  expect(text).toContain('Passive sharing does not wake the other Agent');
  expect(text).toContain(
    'Do not use Peer Message merely to inform the other Agent of an ordinary public answer or local correction',
  );
  expect(text).toContain('pair_message_peer');
  expect(text).toContain('Only the standalone reminder inserted by the Harness');
  expect(text).toContain('does not yet provide structured Goal revision');
  expect(text).toContain("may directly follow a user's change");
  expect(text).toContain('Neither role may accept a request to hide');
  expect(text).not.toContain(
    'Commit Goal revisions through authorized Pair control tools',
  );
});

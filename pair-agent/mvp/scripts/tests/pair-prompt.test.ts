import { expect, test } from 'vitest';

import { P05_PAIR_PROMPT } from '../pair-prompt.js';

test('defines the P0.5 Pair Contract without claiming P1 controls', () => {
  const text = P05_PAIR_PROMPT.commonSystem.content;
  const sections = [
    'PAIR SESSION IDENTITY',
    'USER AUTHORITY AND ROLE CATALOG',
    'SHARED CONTEXT AND EVENT INTERPRETATION',
    'COMMUNICATION AND RESPONSE OWNERSHIP',
    'WEB RESEARCH OWNERSHIP',
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
  expect(text).toContain(
    'Delegated-task completion is coordination that requires Navigator to act',
  );
  expect(text).toContain(
    'must explicitly require a completion report to Navigator',
  );
  expect(text).toContain(
    'must explicitly require Pilot to call pair_report_completion',
  );
  expect(text).toContain(
    'must call pair_report_completion exactly once before the complete final report',
  );
  expect(text).toContain(
    'Successful registration does not mean Navigator has received the report',
  );
  expect(text).toContain(
    'completion status, key results and evidence, and unresolved issues or next steps',
  );
  expect(text).toContain('pair_message_peer');
  expect(text).toContain('expectsReply: true');
  expect(text).toContain('replyTo');
  expect(text).toContain(
    'must answer it with pair_message_peer instead of only replying in the current channel',
  );
  expect(text).toContain(
    'Long-running or long-output work, including article drafting, substantial reports, and large synthesis',
  );
  expect(text).toContain(
    'When the Current Trigger is a completion-handoff, Navigator must cite its Pair Event ID',
  );
  expect(text).toContain(
    'Do not use pair_message_peer for delegated-task completion reports',
  );
  expect(text).toContain('after Agent Local History');
  expect(text).toContain('immediately before the structured Current Trigger');
  expect(text).toContain('is the final message otherwise');
  expect(text).toMatch(
    /regardless of its wording or how many times\s+it appears/,
  );
  expect(text).toContain('does not yet provide structured Goal revision');
  expect(text).toContain('Pilot completion handoff registration');
  expect(text).toContain('web_search');
  expect(text).toContain('Navigator must delegate web research to Pilot');
  expect(text).toContain('cite the relevant source URLs as Markdown links');
  expect(text).toContain("may directly follow a user's change");
  expect(text).toContain('Neither role may accept a request to hide');
  expect(text).not.toContain(
    'Commit Goal revisions through authorized Pair control tools',
  );
  expect(P05_PAIR_PROMPT.roleToolGuidance.navigator).toContain(
    'explicitly require Pilot to call pair_report_completion',
  );
  expect(P05_PAIR_PROMPT.roleToolGuidance.navigator).toContain(
    'Delegate web research to Pilot',
  );
  expect(P05_PAIR_PROMPT.roleToolGuidance.navigator).toContain(
    'Delegate long-form drafting and substantial synthesis to Pilot',
  );
  expect(P05_PAIR_PROMPT.roleToolGuidance.navigator).toContain(
    'reference the completion Pair Event instead of reproducing the full report',
  );
  expect(P05_PAIR_PROMPT.roleToolGuidance.pilot).toContain(
    'call pair_report_completion exactly once before writing the complete final report',
  );
  expect(P05_PAIR_PROMPT.roleToolGuidance.pilot).toContain(
    'Do not use pair_message_peer for that completion report',
  );
  expect(P05_PAIR_PROMPT.roleToolGuidance.pilot).toContain('web_search');
});

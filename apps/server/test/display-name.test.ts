import { expect, test } from 'vitest';
import { DISPLAY_NAME } from '../src/display-name.js';

test.each(['\u0080', '\u0085', '\u009f', '\u2028', '\u2029'])(
  'display names reject embedded single-line control %j', control => {
    const result = DISPLAY_NAME.safeParse(`First${control}Last`);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe('Use a name without control characters.');
  },
);

test('display-name normalization preserves international names and the code-point limit', () => {
  for (const name of ['Renée Example', 'נועה', '李明', 'محمد', '👩‍💻 Developer', '😀'.repeat(80)]) {
    expect(DISPLAY_NAME.parse(`  ${name}  `)).toBe(name);
  }
  expect(DISPLAY_NAME.safeParse('😀'.repeat(81)).success).toBe(false);
});

test.each(['A\nB', 'A\u0000B', 'A\u007fB', 'private@example.test', '   '])(
  'display names retain existing refusal for %j', name => {
    expect(DISPLAY_NAME.safeParse(name).success).toBe(false);
  },
);

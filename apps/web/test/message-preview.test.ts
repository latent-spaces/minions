import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipText, messagePreview } from '../src/ui/message-preview';
import { personInitials } from '../src/ui/person-initials';

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

test('clipping never leaves half an emoji', () => {
  const body = 'a'.repeat(179) + '😀 tail';
  assert.equal(clipText(body, 180), 'a'.repeat(179));
  assert.ok(!loneSurrogate.test(clipText(body, 180)));
  assert.equal(clipText('short', 180), 'short');
  assert.equal(clipText('abc😀', 5), 'abc😀');
});

test('long message previews stay well-formed', () => {
  const preview = messagePreview('b'.repeat(118) + '🎉' + 'c'.repeat(20));
  assert.ok(!loneSurrogate.test(preview));
  assert.ok(preview.endsWith('…'));
});

test('initials take whole characters', () => {
  assert.equal(personInitials('😀 Team'), '😀T');
  assert.equal(personInitials('  Ada  Lovelace '), 'AL');
});

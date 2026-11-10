import { createRequire } from 'node:module';
import { expect, test, vi } from 'vitest';
import type { MessageRow } from '../../apps/web/src/api';

vi.mock('../../apps/web/src/api', () => ({}));
import { MessageDirection, knownMessageSenders } from '../../apps/web/src/ui/ConversationCard';
import { conversationTitle, fullConversationTitle, messagePreview } from '../../apps/web/src/ui/message-preview';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const message = (id: string, sender: MessageRow['sender'], createdAt = 1): MessageRow => ({
  id, threadId: 'thread', createdAt, body: 'Message', sender,
  audience: { kind: 'direct', to: [{ id: 'recipient', name: 'Recipient' }, { id: 'unknown', name: 'Unknown agent' }] },
});

test('human steering shows its profile photo without borrowing the agent owner identity', () => {
  const sender: MessageRow['sender'] = { id: 'person', name: 'Oron', kind: 'person', photo: { id: 'photo', url: '/api/profiles/person/photo/photo' } };
  const html = renderToStaticMarkup(createElement(MessageDirection, { message: message('steering', sender) }));
  expect(html).toContain('src="/api/profiles/person/photo/photo"');
  expect(html).not.toContain('Agent of Oron');
  const fallback = renderToStaticMarkup(createElement(MessageDirection, { message: message('steering', { ...sender, photo: null }) }));
  expect(fallback).not.toContain('/api/profiles/person/photo/photo');
  expect(fallback).toContain('>O</span>');
});

test('recipient badges use observed ownership and never inherit the sending person', () => {
  const first = message('first', {id:'sender',name:'Sender',operatorId:'alice',operatorName:'Alice'});
  const reply = message('reply', {id:'recipient',name:'Recipient',operatorId:'bob',operatorName:'Bob',operatorPhoto:{id:'photo',url:'/api/profiles/bob/photo/photo'}}, 2);
  const html = renderToStaticMarkup(createElement(MessageDirection, {message:first,senders:knownMessageSenders([reply, first])}));
  expect(html).toContain('Agent of Alice');
  expect(html).toContain('Agent of Bob');
  expect(html).toContain('/api/profiles/bob/photo/photo');
  expect(html.match(/class="k42-agent-owner"/g)).toHaveLength(2);
  expect(html).toContain('Unknown agent');
  expect(html).not.toContain('AI agent');
  expect(html).toContain('2 recipients');
  expect(html).toContain('title="Recipient · Agent of Bob"');
  expect(html).toContain('title="Unknown agent"');
});

test('conversation titles stop at a word boundary while retaining full hover text', () => {
  const title = 'A long conversation title '.repeat(10) + 'with its final words preserved';
  expect(fullConversationTitle('\n' + title + '\n\nMessage details')).toBe(title);
  expect(Array.from(conversationTitle(title)).length).toBeLessThanOrEqual(120);
  expect(conversationTitle(title)).toBe('A long conversation title '.repeat(4) + 'A long…');
  expect(messagePreview(title)).toHaveLength(120);
  expect(conversationTitle('Message body', title)).toBe(conversationTitle(title));
  expect(conversationTitle('Short title')).toBe('Short title');
  const emojiTitle = '🙂'.repeat(121);
  expect(conversationTitle(emojiTitle)).toBe('🙂'.repeat(119) + '…');
});

test('newest observed sender metadata wins independently of page order', () => {
  const older = message('older', {id:'recipient',name:'Recipient',operatorId:'bob',operatorName:'Old name'});
  const latest = message('latest', {id:'recipient',name:'Recipient',operatorId:'bob',operatorName:'Current name'}, 2);
  expect(knownMessageSenders([latest, older]).get('recipient')?.operatorName).toBe('Current name');
});


test('group steering exposes per-recipient delivery only outside the conversation toggle', () => {
  const steering=message('group',{id:'person',name:'Alice',kind:'person'});
  steering.steering={state:'queued',origin:'coding_chat',observedAt:null,deliveries:[{agentId:'recipient',agentName:'Recipient',state:'included',observedAt:2},{agentId:'unknown',agentName:'Unknown agent',state:'queued',observedAt:null}]};
  const expanded=renderToStaticMarkup(createElement(MessageDirection,{message:steering}));
  expect(expanded).toContain('<details');
  expect(expanded).toContain('Included in a turn: 1');
  expect(expanded).toContain('Queued: 1');
  expect(expanded.match(/<li>/g)).toHaveLength(2);
  const collapsed=renderToStaticMarkup(createElement(MessageDirection,{message:steering,deliveryDetails:false}));
  expect(collapsed).not.toContain('<details');
  expect(collapsed).toContain('Included in a turn: 1');
  const reply={...message('reply',{id:'agent',name:'Atlas',kind:'agent'}),audience:{kind:'direct' as const,to:[]}};
  expect(renderToStaticMarkup(createElement(MessageDirection,{message:reply}))).toContain('Conversation reply');
});

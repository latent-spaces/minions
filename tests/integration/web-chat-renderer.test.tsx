import { createRequire } from 'node:module';
import { expect, test } from 'vitest';
import { ChatBody, ChatTimeline, MessageBody } from '../../apps/web/src/ui/ChatTimeline.js';

// Use the application's pinned React runtime, rather than adding a second one
// to the test workspace or bringing a DOM emulator into renderer safety tests.
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { createElement } = webRequire('react');
const { renderToStaticMarkup } = webRequire('react-dom/server');
const render = (body: string): string => renderToStaticMarkup(createElement(ChatBody, { body }));

test('opened agent conversations render entire safe messages without another disclosure', () => {
  const body='Technical opening. '.repeat(160)+'Ending beyond the preview';
  const html = timeline(body, {fullMessages:true});
  expect(html).toContain('Technical opening.');
  expect(html).toContain('Ending beyond the preview');
  expect(html).not.toContain('View message');
  expect(html).not.toContain('Show full message');
  const unsafe = timeline('See [PR](https://example.com/pr) <script>alert(1)</script>', {fullMessages:true});
  expect(unsafe).toContain('href="https://example.com/pr"');
  expect(unsafe).not.toContain('<script>');
  const human = renderToStaticMarkup(createElement(MessageBody, { body: 'Human chat stays readable.' }));
  expect(human).toContain('Human chat stays readable.');
  expect(human).not.toContain('Show full message');
});

test('messages display raw HTML and script payloads as inert text', () => {
  const html = render('<img src=x onerror="alert(1)"><script>alert(2)</script>');
  expect(html).toContain('&lt;img');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<img');
  expect(html).not.toContain('<script');
});

test('message linkification permits HTTP(S) links and leaves executable schemes as text', () => {
  const html = render('javascript:alert(1) data:text/html,test https://example.com/docs.');
  expect(html).not.toMatch(/href="(?:javascript|data):/);
  expect(html).toContain('href="https://example.com/docs"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('javascript:alert(1)');
});

test('image references are explicit safe links with no automatic image request', () => {
  const html = render('![Concept](https://example.com/concept.png)\n\n![Unsafe](data:image/svg+xml,test)\n\n[Unsafe link](javascript:alert%281%29)');
  expect(html).toContain('href="https://example.com/concept.png"');
  expect(html).toContain('Concept (open image)');
  expect(html).not.toContain('<img');
  expect(html).not.toMatch(/href="(?:javascript|data):/);
  expect(html).toContain('Unsafe link');
});

function timeline(body: string, extra: object = {}): string {
  return renderToStaticMarkup(createElement(ChatTimeline, {
    messages: [{id:'example',createdAt:1,body}],label:'Test chat',loading:false,empty:'No messages',
    older:()=>{},busy:false,hasOlder:false,senderKey:()=> 'participant',renderIdentity:()=> 'Participant',...extra,
  }));
}

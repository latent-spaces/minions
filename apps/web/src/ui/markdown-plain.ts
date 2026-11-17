/** One-line previews of Markdown text: keeps the words, drops the syntax. Full views render it with ChatBody. */
export function markdownPlain(text: string): string {
  return text
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\W)[*_](\S[^*_]*?)[*_](?=\W|$)/g, '$1$2')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

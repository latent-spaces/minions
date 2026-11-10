/** Where an arrow key moves among a popover's `count` items from `index` (-1: focus is on none of them). Down and Up
 *  wrap; Home and End go to either end. Any other key, or a popover with no items, moves nothing (null). */
export function nextItem(key: string, index: number, count: number): number | null {
  if (count === 0) return null;
  if (key === 'ArrowDown') return index < 0 ? 0 : (index + 1) % count;
  if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

import { Button } from './Button';
import './message-author-filter.css';

export function MessageAuthorFilter({ value, onChange }: { value: 'all' | 'mine'; onChange: (value: 'all' | 'mine') => void }) {
  return <div className="k42-message-author-filter" role="group" aria-label="Message authors">
    <Button type="button" className="soft" aria-pressed={value === 'all'} onClick={() => onChange('all')}>All</Button>
    <Button type="button" className="soft" aria-pressed={value === 'mine'} onClick={() => onChange('mine')}>Me + my agents</Button>
  </div>;
}

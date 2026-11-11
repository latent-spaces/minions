import { useState } from 'react';
import { RUN_LENGTH, validRunMinutes } from '@mlswarm/contracts';

// One "How long?" choice for the job: a few clear options, or another length. Nothing is chosen until the person
// picks; null means no valid length yet.
const OTHER = 'other';
export function RunLengthChoice({ value, onChange, label, id, disabled = false }: { value: number | null; onChange: (value: number | null) => void; label: string; id: string; disabled?: boolean }) {
  const [other, setOther] = useState(false), [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<'hours' | 'minutes'>('minutes');
  const custom = (text: string, inUnit: 'hours' | 'minutes') => { const minutes = Math.round(Number(text) * (inUnit === 'hours' ? 60 : 1)); onChange(text.trim() !== '' && validRunMinutes(minutes) ? minutes : null); };
  return <span className="k42-run-length">
    <label htmlFor={id}>{label} <select id={id} disabled={disabled} value={other ? OTHER : value === null ? '' : String(value)} onChange={e => {
      const v = e.target.value;
      if (v === OTHER) { setOther(true); custom(amount, unit); return; }
      setOther(false); onChange(Number(v));
    }}>
      <option value="" disabled>Choose…</option>
      {RUN_LENGTH.presets.map(m => <option key={m} value={m}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>)}
      <option value={OTHER}>Other…</option>
    </select></label>
    {other && <span className="k42-run-length-other">
      <input aria-label="Length" type="number" min={1} step="any" disabled={disabled} value={amount} onChange={e => { setAmount(e.target.value); custom(e.target.value, unit); }} />
      <select aria-label="Unit" disabled={disabled} value={unit} onChange={e => { const u = e.target.value as 'hours' | 'minutes'; setUnit(u); custom(amount, u); }}><option value="minutes">minutes</option><option value="hours">hours</option></select>
      <small className="muted">5 minutes to 24 hours, in steps of 5 minutes</small>
    </span>}
  </span>;
}

import { useId } from 'react';
import { Button } from './Button';
import './setting-toggle.css';

export function SettingToggle({ label, value, disabled = false, onChange }: {
  label: string; value: boolean; disabled?: boolean; onChange: (value: boolean) => void;
}) {
  const id = useId();
  return <div className="setting-toggle">
    <span id={id}>{label}</span>
    <div className="setting-toggle-options" role="group" aria-labelledby={id}>
      {[true, false].map(option => <Button key={String(option)} type="button" aria-pressed={value === option}
        disabled={disabled} onClick={() => { if (value !== option) onChange(option); }}>{option ? 'On' : 'Off'}</Button>)}
    </div>
  </div>;
}

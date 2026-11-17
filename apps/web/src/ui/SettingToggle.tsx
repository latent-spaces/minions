import { useId } from 'react';
import { Button } from './Button';
import { InfoTip } from './InfoTip';
import './setting-toggle.css';

export function SettingToggle({ label, info, value, disabled = false, onChange }: {
  label: string; info?: string; value: boolean; disabled?: boolean; onChange: (value: boolean) => void;
}) {
  const id = useId();
  return <div className="setting-toggle">
    <span className="setting-toggle-label"><span id={id}>{label}</span>{info && <InfoTip label={label}>{info}</InfoTip>}</span>
    <div className="setting-toggle-options" role="group" aria-labelledby={id}>
      {[true, false].map(option => <Button key={String(option)} type="button" aria-pressed={value === option}
        disabled={disabled} onClick={() => { if (value !== option) onChange(option); }}>{option ? 'On' : 'Off'}</Button>)}
    </div>
  </div>;
}

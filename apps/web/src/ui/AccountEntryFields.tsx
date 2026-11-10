import { Button } from './Button';
import { GitHubIcon } from './GitHubIcon';

export function GitHubSignInButton({ onClick, disabled, pending, label = 'Sign in with GitHub', className = 'k42-join-primary' }: {
  onClick: () => void; disabled: boolean; pending: boolean; label?: string; className?: string;
}) {
  return <Button type="button" className={`primary ${className}`} disabled={disabled} aria-busy={pending} onClick={onClick}>
    <GitHubIcon size={18} />{pending ? 'Signing in…' : label}
  </Button>;
}

/** Account creation asks for the same bounded display name in both invitation modes. */
export function AccountNameField({ id, value, disabled, onChange }: {
  id: string; value: string; disabled: boolean; onChange: (name: string) => void;
}) {
  return <><label htmlFor={id}>Your display name</label><input id={id} required maxLength={80} autoComplete="nickname" value={value} disabled={disabled} onChange={event => onChange(event.target.value)} /></>;
}

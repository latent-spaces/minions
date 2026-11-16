import { Cpu } from './icons';
import './model-mark.css';

import { modelFamily } from './model-family';
export { modelFamily } from './model-family';

export function ModelMark({ model, provider }: { model: string | null | undefined; provider?: string | null }) {
  if (!model) return null;
  const family = modelFamily(model, provider);
  return <span className={`k42-model-mark is-${family?.tone ?? 'other'}`} title={family?.label ?? 'Model'} aria-hidden="true">
    {family ? family.label[0] : <Cpu size={12} />}
  </span>;
}

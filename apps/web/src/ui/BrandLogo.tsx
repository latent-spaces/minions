import mark from './assets/brand/minions-mark.png';
import word from './assets/brand/minions-word.png';
import pupils from './assets/brand/minions-pupils.png';

// The Minions logo, from the owner's artwork (16 November 2026): the creature is filled with the app's gradient and the
// wordmark stays ink. The eyes are cut out of the gradient and the pupils stay black on top.
/** `markOnly` shows just the creature, for the collapsed menu (owner, 16 November 2026). */
export function BrandLogo({ markOnly = false }: { markOnly?: boolean }) {
  return <span className="wordmark-logo k42-brand-logo" role="img" aria-label="Minions">
    <span className="k42-brand-mark" aria-hidden="true"><span className="k42-brand-body" style={{ maskImage: `url(${mark})`, WebkitMaskImage: `url(${mark})` }} /><img src={pupils} alt="" /></span>
    {!markOnly && <img className="k42-brand-word" src={word} alt="" aria-hidden="true" />}
  </span>;
}

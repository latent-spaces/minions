import { useState } from 'react';
import type React from 'react';
import './confetti.css';

const COLORS = ['#ff7ab8', '#a98bff', '#ffb36b', '#5ed38a', '#0066ff', '#ffc65c'];

/** A short burst of confetti for the first project (owner, 16 November 2026). Decorative; hidden with reduced motion. */
export function Confetti({ count = 70 }: { count?: number }) {
  const [pieces] = useState(() => Array.from({ length: count }, (_, i) => ({
    left: Math.random() * 100, delay: Math.random() * .5, duration: 1.8 + Math.random() * 1.4, drift: (Math.random() - .5) * 160,
    spin: (Math.random() - .5) * 900, color: COLORS[i % COLORS.length], round: Math.random() < .35, size: 6 + Math.random() * 6,
  })));
  return <span className="k42-confetti" aria-hidden="true">{pieces.map((p, i) => <i key={i} className={p.round ? 'is-round' : undefined} style={{
    left: `${p.left}%`, width: p.size, height: p.round ? p.size : p.size * .45, background: p.color, animationDelay: `${p.delay}s`, animationDuration: `${p.duration}s`,
    '--drift': `${p.drift}px`, '--spin': `${p.spin}deg` } as React.CSSProperties} />)}</span>;
}

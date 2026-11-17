// Projects show a soft multicolour gradient instead of a picture (owner, 19 October 2026): sunny yellow, peach,
// pink, lilac and sky blue blending like light through glass. Each project's stable ID picks its mix across every surface, including after a rename.

const PALETTE = ['#FFE27A', '#FFB38A', '#FF9EC7', '#D9A8FF', '#9CC8FF', '#7EB6FF', '#A8E6FF', '#FFC7E1'];
const SPOTS = [[0, 0], [100, 0], [0, 100], [100, 100], [50, 0], [50, 100]];

function hash(text: string) {
  let value = 2166136261;
  for (const char of text) value = Math.imul(value ^ char.charCodeAt(0), 16777619) >>> 0;
  return value;
}

/** A CSS background: four soft colour fields over a light base, picked and placed by the seed. */
export function projectGradient(seed: string): string {
  const h = hash(seed || 'minions');
  const colours = [0, 1, 2, 3].map(i => PALETTE[(h >>> (i * 3)) % PALETTE.length]);
  const spots = [0, 1, 2, 3].map(i => SPOTS[(h >>> (12 + i * 3)) % SPOTS.length]);
  const fields = colours.map((colour, i) => `radial-gradient(circle at ${spots[i][0]}% ${spots[i][1]}%, ${colour} 0%, ${colour}00 ${62 + (i * 7)}%)`);
  return [...fields, `linear-gradient(${(h % 360)}deg, #FFF4D6, #FDE4F2 45%, #E3ECFF)`].join(', ');
}

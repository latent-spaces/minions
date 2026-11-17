// What the read-only project Card (ProjectCard.tsx) says about stored values, kept pure so it is tested
// without a browser. A missing value stays Unknown.
export const known = (value: string | null | undefined): string => value?.trim() ? value : 'Unknown';

import type { ComponentPropsWithRef } from 'react';

export type ButtonProps = ComponentPropsWithRef<'button'>;

// Keep the exact native element, attributes, form semantics and existing CSS.
// React 19 passes refs through props, including the viewer's focus-return refs.
// No default type, classes, wrapper or styles are added during extraction.
export function Button(props: ButtonProps) {
  return <button {...props} />;
}

import type { ComponentPropsWithRef } from 'react';

// Preserve native modal focus, Escape handling and imperative showModal/close refs.
export function Dialog(props: ComponentPropsWithRef<'dialog'>) {
  return <dialog {...props} />;
}

import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';
import './tooltip.css';

// A short hover/focus label for compact controls, mostly icon-only buttons. The child keeps its own
// accessible name (aria-label); the tooltip is linked as its description and never takes pointer events.
export function Tooltip({label,children,align='center',side='top',wrap=false}:{label:string;wrap?:boolean;children:ReactElement<{'aria-describedby'?:string;children?:ReactNode}>;align?:'start'|'center'|'end';side?:'top'|'bottom'}) {
  const id=useId();
  const describe = (element: ReactElement<{'aria-describedby'?: string}>) => cloneElement(element, { 'aria-describedby': [element.props['aria-describedby'], id].filter(Boolean).join(' ') });
  // A disclosure's summary receives keyboard focus; details itself does not.
  const target = children.type === 'details' ? cloneElement(children, {}, Children.map(children.props.children, child =>
    isValidElement<{'aria-describedby'?: string}>(child) && child.type === 'summary' ? describe(child) : child)) : describe(children);
  return <span className={`k42-tooltip-anchor is-${align} is-${side}${wrap?' is-wrap':''}`}>{target}<span id={id} role="tooltip" className="k42-tooltip">{label}</span></span>;
}

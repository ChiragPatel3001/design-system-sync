import type { HTMLAttributes, ReactNode } from 'react';
import './Menu.css';

/**
 * Figma component: Menu (node 18:384, component, section "Menu"). Composes
 * a list of MenuItem instances, per the manifest's "contains" list
 * (6 .menu item instances in the Figma example composition).
 *
 * Figma measured this component at a fixed 323px width; here it defaults
 * to 100% of its container instead so it can be reused at other widths
 * (see design-system/implementation-notes.md). The Figma "scrollbar"
 * boolean property and its .menu item/.scrollbar sub-component are out of
 * scope for this POC (not one of the 10 approved components) — native
 * overflow scrolling is used instead if content exceeds max-height.
 */
export interface MenuProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Menu({ children, className, ...rest }: MenuProps) {
  return (
    <div className={['ds-menu', className].filter(Boolean).join(' ')} role="menu" {...rest}>
      {children}
    </div>
  );
}

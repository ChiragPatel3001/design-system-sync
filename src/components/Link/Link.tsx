import type { AnchorHTMLAttributes, ReactNode } from 'react';
import './Link.css';

/**
 * Figma component: Link (node 18:503, component_set, section "Navigation").
 *
 * Figma variant axis "Type" (Default/Active/Disabled/focus) -> `variant`
 * prop. Only "Focus" is a real interaction state (implemented as CSS
 * :focus-visible); "Default"/"Active"/"Disabled" are genuine content/design
 * states with no browser-native equivalent for an anchor (there is no
 * :active-as-"current-page" or native `disabled` on <a>), so all three stay
 * explicit `variant` values. When `variant="disabled"`, `href` is withheld,
 * `aria-disabled` is set and the element is removed from the tab order.
 *
 * Known limitation (manifest F12): Code Connect maps the trailing icon to
 * IconArrowUpRight with size="48" on this component's 20px icon slot. The
 * icon slot here is sized at 20px (matching the actual Figma layout) rather
 * than reproducing that mismatch — see design-system/implementation-notes.md.
 */
export type LinkVariant = 'default' | 'active' | 'disabled';

export interface LinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  variant?: LinkVariant;
  href?: string;
  /** Figma component property "iconLeft" (boolean) + "iconLeft1" (instance swap, default Home icon). */
  iconLeft?: ReactNode;
  /** Figma component property "iconRight1" (boolean) + "iconRight" (instance swap, default Arrow up-right icon). */
  iconRight?: ReactNode;
  /** Figma component property "label" (TEXT, default "Link"). */
  children?: ReactNode;
}

export function Link({
  variant = 'default',
  iconLeft,
  iconRight,
  children = 'Link',
  className,
  href,
  ...rest
}: LinkProps) {
  const isDisabled = variant === 'disabled';
  const classNames = ['ds-link', `ds-link--${variant}`, className].filter(Boolean).join(' ');

  return (
    <a
      className={classNames}
      href={isDisabled ? undefined : href}
      aria-disabled={isDisabled || undefined}
      tabIndex={isDisabled ? -1 : undefined}
      {...rest}
    >
      {iconLeft ? <span className="ds-link__icon ds-link__icon--left">{iconLeft}</span> : null}
      <span className="ds-link__label">{children}</span>
      {iconRight ? <span className="ds-link__icon ds-link__icon--right">{iconRight}</span> : null}
    </a>
  );
}

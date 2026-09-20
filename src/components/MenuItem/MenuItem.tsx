import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './MenuItem.css';

/**
 * Figma component: .menu item (node 18:315, component_set, internal —
 * leading "." hides it from Figma publishing; section "Menu").
 *
 * Figma variant axis "Status" (Unselected/Selected) -> `selected` prop.
 * Figma variant axis "State" (Default/hover/disabled) is an interaction
 * state: hover via CSS, disabled via the native `disabled` attribute.
 *
 * Known limitation (manifest F11): Figma defines no focus state for this
 * component. Rendered as a real <button role="menuitem"> here, so a
 * :focus-visible outline (using the same Border/focus token used
 * elsewhere) is added for keyboard accessibility — an addition beyond the
 * Figma spec, not a value taken from it. See
 * design-system/implementation-notes.md.
 *
 * Figma measured a fixed 270px label width inside a 323px-wide item; the
 * label uses flex:1 here instead, so the component works at any container
 * width (see implementation-notes.md).
 */
export interface MenuItemProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** Figma variant axis "Status". */
  selected?: boolean;
  /** Figma component property "icon2" (boolean) + "icon" (instance swap, default Arrow right-circle). */
  icon?: ReactNode;
  /** Figma component property "label" (TEXT, default "Menu"). */
  children?: ReactNode;
}

export function MenuItem({
  selected = false,
  icon,
  children = 'Menu',
  className,
  disabled,
  ...rest
}: MenuItemProps) {
  const classNames = [
    'ds-menu-item',
    selected ? 'ds-menu-item--selected' : 'ds-menu-item--unselected',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      role="menuitem"
      aria-current={selected || undefined}
      className={classNames}
      disabled={disabled}
      {...rest}
    >
      <span className="ds-menu-item__label">{children}</span>
      {icon ? <span className="ds-menu-item__icon">{icon}</span> : null}
    </button>
  );
}

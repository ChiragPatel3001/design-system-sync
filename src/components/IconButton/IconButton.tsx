import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './IconButton.css';

/**
 * Figma component: Button_Icon (node 15:880, component_set, section "Buttons").
 * Icon-only sibling of Button, sharing the same Type/state token matrix.
 *
 * Figma's single instance-swap "icon" property becomes a required `icon`
 * prop. `aria-label` is required (not present in the Figma definition) since
 * an icon-only control has no accessible name otherwise.
 */
export type IconButtonVariant = 'default' | 'outline' | 'transparent';

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'aria-label'> {
  variant?: IconButtonVariant;
  /** Figma component property "icon" (INSTANCE_SWAP, default favorite/heart icon). */
  icon: ReactNode;
  'aria-label': string;
}

export function IconButton({
  variant = 'default',
  icon,
  className,
  disabled,
  ...rest
}: IconButtonProps) {
  const classNames = ['ds-icon-button', `ds-icon-button--${variant}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={classNames} disabled={disabled} {...rest}>
      <span className="ds-icon-button__icon">{icon}</span>
    </button>
  );
}

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './Button.css';

/**
 * Figma component: Button (node 15:664, component_set, section "Buttons").
 *
 * Figma variant axis "Type" -> `variant` prop (renamed to avoid colliding
 * with the native <button> `type` attribute; see implementation-notes.md).
 * Figma variant axis "Property 1" (Default/Hover/Focus/Disabled) is an
 * interaction state, not an author-facing prop: Hover/Focus are implemented
 * as CSS :hover/:focus-visible, Disabled as the native `disabled` attribute.
 */
export type ButtonVariant = 'default' | 'outline' | 'transparent';

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** Figma variant axis "Type". */
  variant?: ButtonVariant;
  /** Figma component property "iconLeft" (boolean) + "iconLeft1" (instance swap). */
  iconLeft?: ReactNode;
  /** Figma component property "iconRight" (boolean) + "iconRight1" (instance swap). */
  iconRight?: ReactNode;
  /** Figma component property "label" (TEXT, default "Button"). */
  children?: ReactNode;
}

export function Button({
  variant = 'default',
  iconLeft,
  iconRight,
  children = 'Button',
  className,
  disabled,
  ...rest
}: ButtonProps) {
  const classNames = ['ds-button', `ds-button--${variant}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={classNames} disabled={disabled} {...rest}>
      {iconLeft ? (
        <span className="ds-button__icon ds-button__icon--left">{iconLeft}</span>
      ) : null}
      <span className="ds-button__label">{children}</span>
      {iconRight ? (
        <span className="ds-button__icon ds-button__icon--right">{iconRight}</span>
      ) : null}
    </button>
  );
}

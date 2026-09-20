import type { InputHTMLAttributes, ReactNode } from 'react';
import './TextField.css';

/**
 * Figma component: Field (node 18:130, component_set, section "Form Inputs").
 *
 * Figma variant axis "Type" (Default/Filled/Error) -> `variant` prop
 * (renamed to avoid colliding with the native <input> `type` attribute).
 * Figma variant axis "Status" (Default/hover/focus/disabled) is an
 * interaction state: hover/focus are CSS :hover/:focus-within, disabled is
 * the native `disabled` attribute.
 *
 * Renders a real <input> wrapped in a styled container, so the leading/
 * trailing icon slots can sit alongside it while the input itself stays
 * accessible and behaves like a normal form control.
 */
export type TextFieldVariant = 'default' | 'filled' | 'error';

export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** Figma variant axis "Type". */
  variant?: TextFieldVariant;
  /** Figma component property "iconLeft" (boolean) + "iconLeft1" (instance swap, default mail icon). */
  leadingIcon?: ReactNode;
  /** Figma component property "iconRight1" (boolean) + "iconRight" (instance swap, default Help circle icon). */
  trailingIcon?: ReactNode;
}

export function TextField({
  variant = 'default',
  leadingIcon,
  trailingIcon,
  className,
  disabled,
  placeholder = 'Placeholder',
  ...rest
}: TextFieldProps) {
  const wrapperClassNames = [
    'ds-textfield',
    `ds-textfield--${variant}`,
    disabled ? 'ds-textfield--disabled' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={wrapperClassNames}>
      {leadingIcon ? (
        <span className="ds-textfield__icon ds-textfield__icon--leading">{leadingIcon}</span>
      ) : null}
      <input
        className="ds-textfield__input"
        disabled={disabled}
        placeholder={placeholder}
        {...rest}
      />
      {trailingIcon ? (
        <span className="ds-textfield__icon ds-textfield__icon--trailing">{trailingIcon}</span>
      ) : null}
    </div>
  );
}

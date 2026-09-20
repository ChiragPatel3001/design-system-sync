import { useId } from 'react';
import type { ReactNode } from 'react';
import { CheckboxControl } from '../CheckboxControl/CheckboxControl';
import type { CheckboxControlProps } from '../CheckboxControl/CheckboxControl';
import './Checkbox.css';

/**
 * Figma component: Checkbox label (node 19:702, component, section
 * "Checkbox"). Composes .Checkbox item + label text, per the manifest's
 * "contains" list for this component. Has no variants of its own — states
 * come entirely from the nested CheckboxControl.
 */
export interface CheckboxProps extends CheckboxControlProps {
  /** Figma component property "label" (TEXT, default "Label") + "label1" (BOOLEAN, visibility). */
  label?: ReactNode;
}

export function Checkbox({ label, id, disabled, className, ...rest }: CheckboxProps) {
  const generatedId = useId();
  const checkboxId = id ?? generatedId;
  const classNames = [
    'ds-checkbox',
    disabled ? 'ds-checkbox--disabled' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <label htmlFor={checkboxId} className={classNames}>
      <CheckboxControl id={checkboxId} disabled={disabled} {...rest} />
      {label ? <span className="ds-checkbox__label">{label}</span> : null}
    </label>
  );
}

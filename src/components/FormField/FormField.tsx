import { useId } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { FieldLabel } from '../FieldLabel/FieldLabel';
import { TextField } from '../TextField/TextField';
import './FormField.css';

/**
 * Figma component: Input (node 18:256, component_set, section "Form Inputs").
 * Composes FieldLabel + TextField + an optional hint row, per the manifest's
 * "contains" list for this component.
 *
 * Figma's "Type" variant (Default/email) was two fixed content presets
 * (different label text, icon and placeholder). Rather than hardcode two
 * presets, this is generalized into a normal configurable field: label,
 * placeholder and icon are props, and `type` maps directly to the native
 * <input type> attribute (e.g. "email" for keyboard/validation behavior).
 * See design-system/implementation-notes.md.
 *
 * The manifest notes Input hardcodes its nested Field to Status=Default,
 * Type=Default and does not expose Field's own status/type — preserved here
 * by not forwarding a `variant` prop to TextField.
 */
export interface FormFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'placeholder'> {
  id?: string;
  /** Figma-composed Label text. */
  label: string;
  /** Figma Label component property "required" (BOOLEAN). */
  required?: boolean;
  /** Figma Label component property "helpIcon" (BOOLEAN) + "label2" (INSTANCE_SWAP). */
  helpIcon?: ReactNode;
  /** Figma Field component property "iconLeft1" (INSTANCE_SWAP, default mail icon). */
  leadingIcon?: ReactNode;
  /** Figma Field component property "label" (TEXT, default "Placeholder"). */
  placeholder?: string;
  /** Figma component property "caption" (TEXT) + "hintCopy" (BOOLEAN). */
  hint?: string;
}

export function FormField({
  id,
  label,
  required,
  helpIcon,
  leadingIcon,
  placeholder,
  hint,
  disabled,
  className,
  ...rest
}: FormFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;

  return (
    <div className={['ds-formfield', className].filter(Boolean).join(' ')}>
      <FieldLabel htmlFor={inputId} required={required} helpIcon={helpIcon}>
        {label}
      </FieldLabel>
      <TextField
        id={inputId}
        placeholder={placeholder}
        leadingIcon={leadingIcon}
        disabled={disabled}
        aria-describedby={hintId}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="ds-formfield__hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

import type { LabelHTMLAttributes, ReactNode } from 'react';
import './FieldLabel.css';

/**
 * Figma component: Label (node 17:50, component_set, section "Form Inputs").
 *
 * Figma has only one real variant ("Required"); "required" is actually
 * driven by a boolean component property, so it is implemented here as a
 * plain `required` boolean prop rather than a variant enum (see manifest
 * finding F02 and the Label component notes).
 *
 * The asterisk glyph has no color token specified anywhere in the manifest
 * (icons[] lists it with no colorToken). `--color-text-error` is used as a
 * reasonable default for a required-field marker — see
 * design-system/implementation-notes.md.
 */
export interface FieldLabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  /** Figma component property "label" (TEXT, default "Label"). */
  children?: ReactNode;
  /** Figma component property "required" (BOOLEAN). */
  required?: boolean;
  /** Figma component property "helpIcon" (BOOLEAN) + "label2" (INSTANCE_SWAP, default Help circle icon). */
  helpIcon?: ReactNode;
}

export function FieldLabel({
  children = 'Label',
  required = false,
  helpIcon,
  className,
  ...rest
}: FieldLabelProps) {
  const classNames = ['ds-field-label', className].filter(Boolean).join(' ');

  return (
    <label className={classNames} {...rest}>
      <span className="ds-field-label__text">{children}</span>
      {required ? (
        <span className="ds-field-label__required" aria-hidden="true">
          *
        </span>
      ) : null}
      {helpIcon ? <span className="ds-field-label__help-icon">{helpIcon}</span> : null}
    </label>
  );
}

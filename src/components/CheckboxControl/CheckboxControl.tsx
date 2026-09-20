import type { InputHTMLAttributes } from 'react';
import './CheckboxControl.css';

/**
 * Figma component: .Checkbox item (node 19:667, component_set, internal —
 * leading "." hides it from Figma publishing; section "Checkbox").
 *
 * Figma variant axis "Type" (Unselected/Selected) maps to the native
 * `checked`/`defaultChecked` props of a real <input type="checkbox">.
 * Figma variant axis "Status" (Default/hover/focus/disabled) is an
 * interaction state: hover/focus via CSS, disabled via the native attribute.
 *
 * Known limitation (manifest F05): no Selected variant has a check-glyph
 * layer in Figma. A checkmark SVG is added here so the control is legible
 * when checked — see design-system/implementation-notes.md.
 */
export type CheckboxControlProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'size'
>;

export function CheckboxControl({
  className,
  disabled,
  ...rest
}: CheckboxControlProps) {
  const classNames = [
    'ds-checkbox-control',
    disabled ? 'ds-checkbox-control--disabled' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classNames}>
      <input type="checkbox" className="ds-checkbox-control__input" disabled={disabled} {...rest} />
      <svg
        className="ds-checkbox-control__check"
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M3 8.5L6.5 12L13 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

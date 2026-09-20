import type { Meta, StoryObj } from '@storybook/react-vite';
import { FormField } from './FormField';
import { figmaNodeUrl } from '../../storybook-utils/figma-link';

/**
 * Figma: Input (node 18:256, component_set, section "Form Inputs").
 * Composes FieldLabel + TextField + an optional hint row. Figma's
 * Default/email "Type" variant is generalized into props here — see
 * implementation-notes.md.
 */
const MailIcon = () => <span aria-hidden="true">@</span>;
const HelpIcon = () => <span aria-hidden="true">?</span>;

const meta = {
  title: 'Components/FormField',
  component: FormField,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `Figma node [18:256](${figmaNodeUrl('18:256')}) (component_set "Input"), composing FieldLabel + TextField. Figma's Default/email Type variant was generalized into label/placeholder/leadingIcon props plus a native \`type\` attribute — see implementation-notes.md.`,
      },
    },
  },
  argTypes: {
    required: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof FormField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { label: 'Label', placeholder: 'Placeholder' },
};

export const Required: Story = {
  args: { label: 'Label', required: true, helpIcon: <HelpIcon />, placeholder: 'Placeholder' },
};

export const WithHint: Story = {
  name: 'With hint',
  args: {
    label: 'Email',
    leadingIcon: <MailIcon />,
    placeholder: 'john.doe@gmail.com',
    type: 'email',
    hint: "We'll never share your email.",
  },
};

export const Disabled: Story = {
  args: { label: 'Label', placeholder: 'Placeholder', disabled: true },
};

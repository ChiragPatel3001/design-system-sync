import type { Meta, StoryObj } from '@storybook/react-vite';
import { Checkbox } from './Checkbox';
import { figmaNodeUrl } from '../../storybook-utils/figma-link';

/**
 * Figma: Checkbox label (node 19:702, component, section "Checkbox").
 * Composes CheckboxControl + label text. Has no variants of its own —
 * state comes entirely from the nested CheckboxControl (see its own
 * stories under Components/Internal/CheckboxControl for hover/focus).
 */
const meta = {
  title: 'Components/Checkbox',
  component: Checkbox,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `Figma node [19:702](${figmaNodeUrl('19:702')}) (component "Checkbox label"), composing CheckboxControl + label text.`,
      },
    },
  },
  argTypes: {
    checked: { control: 'boolean' },
    disabled: { control: 'boolean' },
    label: { control: 'text' },
  },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unchecked: Story = {
  args: { label: 'Accept terms', checked: false, readOnly: true },
};

export const Checked: Story = {
  args: { label: 'Accept terms', checked: true, readOnly: true },
};

export const Disabled: Story = {
  args: { label: 'Accept terms', disabled: true, readOnly: true },
};

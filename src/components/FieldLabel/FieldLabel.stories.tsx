import type { Meta, StoryObj } from '@storybook/react-vite';
import { FieldLabel } from './FieldLabel';
import { figmaNodeUrl } from '../../storybook-utils/figma-link';

/**
 * Figma: Label (node 17:50, component_set, section "Form Inputs").
 * Has exactly one real Figma variant ("Required"); per manifest finding
 * F02, "required" is driven by a boolean property, so it is a plain
 * `required` prop here rather than a variant enum.
 */
const HelpIcon = () => <span aria-hidden="true">?</span>;

const meta = {
  title: 'Components/FieldLabel',
  component: FieldLabel,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `Figma node [17:50](${figmaNodeUrl('17:50')}) (component_set "Label"). One Figma variant ("Required"); implemented as a \`required\` boolean prop — see manifest finding F02.`,
      },
    },
  },
  argTypes: {
    required: { control: 'boolean' },
    children: { control: 'text', description: 'Figma component property "label".' },
  },
} satisfies Meta<typeof FieldLabel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: 'Label' },
};

export const Required: Story = {
  args: { children: 'Label', required: true },
};

export const WithHelpIcon: Story = {
  name: 'With help icon',
  args: { children: 'Label', required: true, helpIcon: <HelpIcon /> },
};

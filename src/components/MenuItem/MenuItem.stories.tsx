import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import { MenuItem } from './MenuItem';
import { figmaNodeUrl } from '../../storybook-utils/figma-link';

/**
 * Figma: .menu item (node 18:315, component_set, INTERNAL — leading "."
 * hides it from Figma publishing). Grouped under Components/Internal since
 * this is meant to be composed inside Menu, not used standalone.
 */
const ArrowIcon = () => <span aria-hidden="true">&rarr;</span>;

const meta = {
  title: 'Components/Internal/MenuItem',
  component: MenuItem,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `Figma node [18:315](${figmaNodeUrl('18:315')}) (component_set ".menu item", internal in Figma too). Status Unselected/Selected -> \`selected\` prop; State hover/disabled are CSS states. Manifest finding F11: Figma defines no focus state for this component — the Focus story below demonstrates a code-added :focus-visible outline, not a Figma-sourced state.`,
      },
    },
  },
  args: {
    children: 'Menu item',
    icon: <ArrowIcon />,
  },
  argTypes: {
    selected: { control: 'boolean', description: 'Figma variant axis "Status".' },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof MenuItem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { selected: false },
};

export const Selected: Story = {
  args: { selected: true },
};

export const Disabled: Story = {
  args: { selected: false, disabled: true },
};

export const Hover: Story = {
  args: { selected: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByRole('menuitem'));
  },
};

export const Focus: Story = {
  name: 'Focus (not in Figma — accessibility addition)',
  args: { selected: false },
  play: async () => {
    await userEvent.tab();
  },
};

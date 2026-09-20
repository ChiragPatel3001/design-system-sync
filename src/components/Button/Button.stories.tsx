import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import { Button } from './Button';
import { figmaNodeUrl } from '../../storybook-utils/figma-link';

/**
 * Figma: Button (node 15:664, component_set, section "Buttons").
 * Registry: design-system/registry.json -> components[] where figmaNodeId = "15:664".
 *
 * "Hover" and "Focus" below are not props — they are the same CSS
 * :hover / :focus-visible rules Default uses, triggered here via a `play`
 * function (real pointer/keyboard events) rather than an invented prop.
 * See implementation-notes.md, "Interaction states → CSS, not props."
 */
const meta = {
  title: 'Components/Button',
  component: Button,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `Figma node [15:664](${figmaNodeUrl('15:664')}) (component_set "Button"). Type Default/Outline/Transparent -> \`variant\` prop; Hover/Focus/Disabled are CSS states, not props.`,
      },
    },
  },
  argTypes: {
    variant: {
      control: 'radio',
      options: ['default', 'outline', 'transparent'],
      description: 'Figma variant axis "Type".',
    },
    disabled: { control: 'boolean' },
    children: { control: 'text', description: 'Figma component property "label".' },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { variant: 'default', children: 'Button' },
};

export const Outline: Story = {
  args: { variant: 'outline', children: 'Button' },
};

export const Transparent: Story = {
  args: { variant: 'transparent', children: 'Button' },
};

export const WithIcon: Story = {
  name: 'With icon',
  args: {
    variant: 'default',
    children: 'Favorite',
    iconLeft: <span aria-hidden="true">&hearts;</span>,
  },
};

export const Disabled: Story = {
  args: { variant: 'default', children: 'Button', disabled: true },
};

export const Hover: Story = {
  args: { variant: 'default', children: 'Button' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByRole('button'));
  },
};

export const Focus: Story = {
  args: { variant: 'default', children: 'Button' },
  play: async () => {
    await userEvent.tab();
  },
};

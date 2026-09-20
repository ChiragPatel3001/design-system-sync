import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import { IconButton } from './IconButton';
import { figmaNodeUrl } from '../../storybook-utils/figma-link';

/**
 * Figma: Button_Icon (node 15:880, component_set, section "Buttons").
 * Icon-only sibling of Button sharing the same Type/state token matrix.
 */
const HeartIcon = () => <span aria-hidden="true">&hearts;</span>;

const meta = {
  title: 'Components/IconButton',
  component: IconButton,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `Figma node [15:880](${figmaNodeUrl('15:880')}) (component_set "Button_Icon"). Same Type/state matrix as Button, icon-only.`,
      },
    },
  },
  args: {
    icon: <HeartIcon />,
    'aria-label': 'Favorite',
  },
  argTypes: {
    variant: {
      control: 'radio',
      options: ['default', 'outline', 'transparent'],
      description: 'Figma variant axis "Type".',
    },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof IconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { variant: 'default' },
};

export const Outline: Story = {
  args: { variant: 'outline' },
};

export const Transparent: Story = {
  args: { variant: 'transparent' },
};

export const Disabled: Story = {
  args: { variant: 'default', disabled: true },
};

export const Hover: Story = {
  args: { variant: 'default' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByRole('button'));
  },
};

export const Focus: Story = {
  args: { variant: 'default' },
  play: async () => {
    await userEvent.tab();
  },
};

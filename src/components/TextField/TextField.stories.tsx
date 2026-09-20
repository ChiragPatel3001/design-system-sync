import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import { TextField } from './TextField';
import { figmaNodeUrl } from '../../storybook-utils/figma-link';

/**
 * Figma: Field (node 18:130, component_set, section "Form Inputs").
 * Status (Default/hover/focus/disabled) is CSS-driven; Type
 * (Default/Filled/Error) is the `variant` prop.
 */
const MailIcon = () => <span aria-hidden="true">@</span>;
const HelpIcon = () => <span aria-hidden="true">?</span>;

const meta = {
  title: 'Components/TextField',
  component: TextField,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `Figma node [18:130](${figmaNodeUrl('18:130')}) (component_set "Field"). Type Default/Filled/Error -> \`variant\` prop; Status hover/focus/disabled are CSS states, not props.`,
      },
    },
  },
  argTypes: {
    variant: {
      control: 'radio',
      options: ['default', 'filled', 'error'],
      description: 'Figma variant axis "Type".',
    },
    disabled: { control: 'boolean' },
    placeholder: { control: 'text', description: 'Figma component property "label".' },
  },
} satisfies Meta<typeof TextField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { variant: 'default', placeholder: 'Placeholder' },
};

export const Filled: Story = {
  args: { variant: 'filled', defaultValue: 'Filled value' },
};

export const Error: Story = {
  args: { variant: 'error', defaultValue: 'Invalid value' },
};

export const WithIcons: Story = {
  name: 'With icons',
  args: {
    variant: 'default',
    placeholder: 'john.doe@gmail.com',
    leadingIcon: <MailIcon />,
    trailingIcon: <HelpIcon />,
  },
};

export const Disabled: Story = {
  args: { variant: 'default', placeholder: 'Placeholder', disabled: true },
};

export const Hover: Story = {
  args: { variant: 'default', placeholder: 'Placeholder' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByRole('textbox'));
  },
};

export const Focus: Story = {
  args: { variant: 'default', placeholder: 'Placeholder' },
  play: async () => {
    await userEvent.tab();
  },
};

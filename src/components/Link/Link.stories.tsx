import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent } from 'storybook/test';
import { Link } from './Link';
import { figmaNodeUrl } from '../../storybook-utils/figma-link';

/**
 * Figma: Link (node 18:503, component_set, section "Navigation").
 * Type Default/Active/Disabled -> `variant` prop; Type=focus is CSS
 * :focus-visible. Manifest finding F12: the trailing-icon Code Connect
 * mapping is sized 48px into a 20px slot — implemented here at the correct
 * 20px, not the mismatched mapping.
 */
const HomeIcon = () => <span aria-hidden="true">&#8962;</span>;
const ArrowIcon = () => <span aria-hidden="true">&#8599;</span>;

const meta = {
  title: 'Components/Link',
  component: Link,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `Figma node [18:503](${figmaNodeUrl('18:503')}) (component_set "Link"). Type Default/Active/Disabled -> \`variant\` prop; Type=focus is CSS :focus-visible, not a variant value.`,
      },
    },
  },
  args: { children: 'Link', href: '#' },
  argTypes: {
    variant: {
      control: 'radio',
      options: ['default', 'active', 'disabled'],
      description: 'Figma variant axis "Type" (Default/Active/Disabled; "focus" is CSS-driven).',
    },
  },
} satisfies Meta<typeof Link>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { variant: 'default' },
};

export const Active: Story = {
  args: { variant: 'active' },
};

export const Disabled: Story = {
  args: { variant: 'disabled' },
};

export const WithIcons: Story = {
  name: 'With icons',
  args: { variant: 'default', iconLeft: <HomeIcon />, iconRight: <ArrowIcon /> },
};

export const Focus: Story = {
  args: { variant: 'default' },
  play: async () => {
    await userEvent.tab();
  },
};

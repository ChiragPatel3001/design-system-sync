import type { Meta, StoryObj } from '@storybook/react-vite';
import { Menu } from './Menu';
import { MenuItem } from '../MenuItem/MenuItem';
import { figmaNodeUrl } from '../../storybook-utils/figma-link';

/**
 * Figma: Menu (node 18:384, component, section "Menu"). Composes a list of
 * .menu item instances (MenuItem). The Figma .menu item/.scrollbar
 * sub-component is out of scope for this POC — see implementation-notes.md.
 */
const ArrowIcon = () => <span aria-hidden="true">&rarr;</span>;

const meta = {
  title: 'Components/Menu',
  component: Menu,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `Figma node [18:384](${figmaNodeUrl('18:384')}) (component "Menu"), composing MenuItem instances. The Figma .menu item/.scrollbar sub-component is out of scope for this POC; native overflow scrolling is used instead.`,
      },
    },
  },
} satisfies Meta<typeof Menu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: null },
  render: () => (
    <Menu>
      {['Overview', 'Analytics', 'Reports', 'Settings'].map((label, index) => (
        <MenuItem key={label} selected={index === 1} icon={<ArrowIcon />}>
          {label}
        </MenuItem>
      ))}
    </Menu>
  ),
};

export const WithDisabledItem: Story = {
  name: 'With disabled item',
  args: { children: null },
  render: () => (
    <Menu>
      <MenuItem icon={<ArrowIcon />}>Overview</MenuItem>
      <MenuItem selected icon={<ArrowIcon />}>
        Analytics
      </MenuItem>
      <MenuItem disabled icon={<ArrowIcon />}>
        Archived (disabled)
      </MenuItem>
    </Menu>
  ),
};

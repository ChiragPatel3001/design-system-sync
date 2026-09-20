import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
import { CheckboxControl } from './CheckboxControl';
import { figmaNodeUrl } from '../../storybook-utils/figma-link';

/**
 * Figma: .Checkbox item (node 19:667, component_set, INTERNAL — leading "."
 * hides it from Figma publishing). Grouped under Components/Internal since
 * this is a styling primitive, not a component meant to be used directly
 * (use Checkbox, which composes this + a label, instead).
 */
const meta = {
  title: 'Components/Internal/CheckboxControl',
  component: CheckboxControl,
  tags: ['autodocs'],
  parameters: {
    docs: {
      description: {
        component: `Figma node [19:667](${figmaNodeUrl('19:667')}) (component_set ".Checkbox item", internal in Figma too). Type Unselected/Selected -> native \`checked\`; Status hover/focus/disabled are CSS states. Manifest finding F05: no check-glyph layer exists in Figma for Selected — the checkmark SVG here is a code addition.`,
      },
    },
  },
  args: {
    'aria-label': 'Checkbox control demo',
  },
  argTypes: {
    checked: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
} satisfies Meta<typeof CheckboxControl>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Unselected: Story = {
  args: { checked: false, readOnly: true },
};

export const Selected: Story = {
  args: { checked: true, readOnly: true },
};

export const Disabled: Story = {
  args: { checked: false, disabled: true, readOnly: true },
};

export const DisabledSelected: Story = {
  name: 'Disabled, selected',
  args: { checked: true, disabled: true, readOnly: true },
};

export const Hover: Story = {
  args: { checked: false, readOnly: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.hover(canvas.getByRole('checkbox'));
  },
};

export const Focus: Story = {
  args: { checked: false, readOnly: true },
  play: async () => {
    await userEvent.tab();
  },
};

import type { Preview } from '@storybook/react-vite';
import '../src/tokens/index.css';

/**
 * Storybook-specific adjustment (see design-system/implementation-notes.md,
 * "Storybook setup"): components consume CSS custom properties defined in
 * src/tokens/index.css. The Vite app loads that file once in src/main.tsx;
 * Storybook renders each story in isolation and never touches main.tsx, so
 * the token stylesheet is imported here instead, globally, for every story.
 */
const preview: Preview = {
  parameters: {
    layout: 'centered',
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;

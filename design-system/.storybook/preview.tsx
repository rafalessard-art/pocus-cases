import React from 'react';
import type { Preview } from '@storybook/react';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/dark.css';

// Toolbar toggle to preview any story in light or dark.
export const globalTypes = {
  theme: {
    description: 'Design system theme',
    defaultValue: 'light',
    toolbar: {
      title: 'Theme',
      icon: 'paintbrush',
      items: [
        { value: 'light', title: 'Light' },
        { value: 'dark', title: 'Dark' },
      ],
      dynamicTitle: true,
    },
  },
};

const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: true },
  },
  decorators: [
    (Story, context) => {
      const dark = context.globals.theme === 'dark';
      return (
        <div
          className={dark ? 'pds-dark' : undefined}
          style={{ background: 'var(--paper)', minHeight: '100vh', padding: '40px' }}
        >
          <Story />
        </div>
      );
    },
  ],
};

export default preview;

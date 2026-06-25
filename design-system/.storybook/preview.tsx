import React from 'react';
import type { Preview } from '@storybook/react';
import '../src/styles/tokens.css';
import '../src/styles/base.css';

// Every story renders on the warm "paper" canvas, like the real site.
const preview: Preview = {
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: true },
  },
  decorators: [
    (Story) => (
      <div style={{ background: 'var(--paper)', minHeight: '100vh', padding: '40px' }}>
        <Story />
      </div>
    ),
  ],
};

export default preview;

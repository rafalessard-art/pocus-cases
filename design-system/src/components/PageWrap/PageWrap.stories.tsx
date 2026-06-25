import type { Meta, StoryObj } from '@storybook/react';
import { PageWrap } from './PageWrap';

const meta: Meta<typeof PageWrap> = {
  title: 'Layout/PageWrap',
  component: PageWrap,
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof PageWrap>;

export const Default: Story = {
  args: {
    children: (
      <div style={{ background: 'var(--paper2)', border: '1px solid var(--rule)', padding: 24 }}>
        Page content lives inside the centered column.
      </div>
    ),
  },
};

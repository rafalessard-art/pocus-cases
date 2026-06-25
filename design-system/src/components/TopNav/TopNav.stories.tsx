import type { Meta, StoryObj } from '@storybook/react';
import { TopNav } from './TopNav';

const meta: Meta<typeof TopNav> = {
  title: 'Layout/TopNav',
  component: TopNav,
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof TopNav>;

export const Default: Story = {
  args: {
    items: [
      { label: 'Home', href: '#home', active: true },
      { label: 'Tools', href: '/tools' },
      { label: 'About', href: '#about' },
      { label: 'Resources', href: '#resources' },
    ],
  },
};

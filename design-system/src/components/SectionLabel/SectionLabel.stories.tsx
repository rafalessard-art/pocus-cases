import type { Meta, StoryObj } from '@storybook/react';
import { SectionLabel } from './SectionLabel';

const meta: Meta<typeof SectionLabel> = {
  title: 'Layout/SectionLabel',
  component: SectionLabel,
};
export default meta;

type Story = StoryObj<typeof SectionLabel>;

export const Default: Story = { args: { children: 'The cases' } };

export const WithoutRule: Story = { args: { children: 'Resources', rule: false } };

import type { Meta, StoryObj } from '@storybook/react';
import { NumBadge } from './NumBadge';

const meta: Meta<typeof NumBadge> = {
  title: 'Cards/NumBadge',
  component: NumBadge,
  args: { accent: 'clay' },
  argTypes: {
    accent: { control: 'select', options: ['petrol', 'clay', 'moss', 'sky', 'gold'] },
    shape: { control: 'inline-radio', options: ['circle', 'pill'] },
  },
};
export default meta;

type Story = StoryObj<typeof NumBadge>;

export const Circle: Story = { args: { children: '1', shape: 'circle' } };
export const Pill: Story = { args: { children: '3D', shape: 'pill', accent: 'sky' } };

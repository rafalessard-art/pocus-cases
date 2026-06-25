import type { Meta, StoryObj } from '@storybook/react';
import { Tag } from './Tag';

const meta: Meta<typeof Tag> = {
  title: 'Cards/Tag',
  component: Tag,
  argTypes: {
    variant: { control: 'inline-radio', options: ['topic', 'meta'] },
    accent: { control: 'select', options: ['petrol', 'clay', 'moss', 'sky', 'gold'] },
  },
};
export default meta;

type Story = StoryObj<typeof Tag>;

export const Topic: Story = { args: { variant: 'topic', accent: 'clay', children: 'Gastric POCUS · Airway' } };
export const MetaText: Story = { args: { variant: 'meta', children: '2-part scenario · interactive 3D' } };

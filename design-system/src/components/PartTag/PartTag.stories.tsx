import type { Meta, StoryObj } from '@storybook/react';
import { PartTag } from './PartTag';

const meta: Meta<typeof PartTag> = {
  title: 'Case content/PartTag',
  component: PartTag,
  argTypes: { accent: { control: 'select', options: ['petrol', 'clay', 'moss', 'sky', 'gold'] } },
};
export default meta;

type Story = StoryObj<typeof PartTag>;

export const Default: Story = { args: { children: 'Part 1 — The assessment' } };

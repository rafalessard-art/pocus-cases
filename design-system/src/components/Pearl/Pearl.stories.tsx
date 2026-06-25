import type { Meta, StoryObj } from '@storybook/react';
import { Pearl } from './Pearl';

const meta: Meta<typeof Pearl> = {
  title: 'Case content/Pearl',
  component: Pearl,
};
export default meta;

type Story = StoryObj<typeof Pearl>;

export const Default: Story = {
  args: {
    label: 'Clinical pearl',
    children: (
      <p>
        A normal ONSD does not rule out raised intracranial pressure — treat a reassuring measurement as one
        data point, not a discharge criterion.
      </p>
    ),
  },
};

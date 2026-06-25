import type { Meta, StoryObj } from '@storybook/react';
import { Masthead } from './Masthead';

const meta: Meta<typeof Masthead> = {
  title: 'Layout/Masthead',
  component: Masthead,
};
export default meta;

type Story = StoryObj<typeof Masthead>;

export const Default: Story = {
  args: {
    kicker: 'Point-of-Care Ultrasound · Perioperative Medicine',
    title: 'POCUS Learning Case Series',
    subtitle: 'Simulated teaching cases for anesthesiology residents',
    stats: [
      { value: 4, label: 'cases available' },
      { value: 1, label: 'in development' },
      { value: 2, label: 'interactive 3D tools' },
    ],
  },
};

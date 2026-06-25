import type { Meta, StoryObj } from '@storybook/react';
import { Panel } from './Panel';

const meta: Meta<typeof Panel> = {
  title: 'Panels/Panel',
  component: Panel,
  argTypes: {
    accent: { control: 'select', options: ['petrol', 'clay', 'moss', 'sky', 'gold'] },
  },
};
export default meta;

type Story = StoryObj<typeof Panel>;

export const About: Story = {
  args: {
    accent: 'gold',
    title: 'About this series',
    children: (
      <>
        <p>
          Created by <strong>Raphael Lessard, MD</strong>, University of Ottawa.
        </p>
        <p>These cases are designed for small-group or self-directed resident teaching.</p>
      </>
    ),
  },
};

export const Resources: Story = {
  args: {
    accent: 'sky',
    title: 'Resources',
    children: (
      <ul>
        <li>
          <a href="https://www.pocus.org">POCUS.org — Point-of-Care Ultrasound Education</a>
        </li>
        <li>
          <a href="https://www.gastricultrasound.org">GastricUltrasound.org</a>
        </li>
      </ul>
    ),
  },
};

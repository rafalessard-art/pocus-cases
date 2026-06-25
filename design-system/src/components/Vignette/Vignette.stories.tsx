import type { Meta, StoryObj } from '@storybook/react';
import { Vignette } from './Vignette';

const meta: Meta<typeof Vignette> = {
  title: 'Case content/Vignette',
  component: Vignette,
};
export default meta;

type Story = StoryObj<typeof Vignette>;

export const Default: Story = {
  args: {
    heading: 'The scenario',
    children: (
      <p>
        A 32-year-old G2P1 woman, 18 hours after an uneventful labour epidural, develops a positional
        frontal headache that worsens on sitting and eases when supine.
      </p>
    ),
  },
};

export const Crisis: Story = {
  args: {
    crisis: true,
    heading: 'PACU crisis',
    children: <p>Minutes after arrival in PACU the patient becomes acutely dyspneic with paradoxical abdominal motion.</p>,
  },
};

import type { Meta, StoryObj } from '@storybook/react';
import { Figure } from './Figure';

const meta: Meta<typeof Figure> = {
  title: 'Case content/Figure',
  component: Figure,
};
export default meta;

type Story = StoryObj<typeof Figure>;

export const WithSvg: Story = {
  args: {
    title: 'Optic nerve sheath, 3 mm posterior to the globe',
    desc: 'Measurement is taken perpendicular to the nerve axis, 3 mm behind the retina.',
    attribution: 'Illustration: POCUS Learning Case Series.',
    children: (
      <svg viewBox="0 0 320 160" width="320" height="160" role="img" aria-label="Schematic of optic nerve sheath">
        <rect width="320" height="160" fill="var(--paper2)" />
        <circle cx="90" cy="80" r="46" fill="none" stroke="var(--petrol)" strokeWidth="4" />
        <line x1="136" y1="80" x2="300" y2="80" stroke="var(--clay)" strokeWidth="4" />
        <line x1="160" y1="64" x2="160" y2="96" stroke="var(--ink)" strokeWidth="2" />
      </svg>
    ),
  },
};

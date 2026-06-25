import type { Meta, StoryObj } from '@storybook/react';
import { EvidenceGrade } from './EvidenceGrade';

const meta: Meta<typeof EvidenceGrade> = {
  title: 'Case content/EvidenceGrade',
  component: EvidenceGrade,
};
export default meta;

type Story = StoryObj<typeof EvidenceGrade>;

export const Default: Story = { args: { children: 'Moderate certainty' } };

export const Inline: Story = {
  render: () => (
    <p style={{ fontFamily: 'var(--serif)' }}>
      ONSD correlates with invasive ICP measurement <EvidenceGrade>Low certainty</EvidenceGrade>
    </p>
  ),
};

import type { Meta, StoryObj } from '@storybook/react';
import { CaseCard } from './CaseCard';

const meta: Meta<typeof CaseCard> = {
  title: 'Cards/CaseCard',
  component: CaseCard,
  argTypes: {
    accent: { control: 'select', options: ['petrol', 'clay', 'moss', 'sky', 'gold'] },
  },
};
export default meta;

type Story = StoryObj<typeof CaseCard>;

export const Live: Story = {
  args: {
    accent: 'clay',
    number: 1,
    topic: 'Gastric POCUS · Airway',
    title: 'Gastric Ultrasound & the Patient on a GLP-1 Receptor Agonist',
    description:
      'Prevalence and theoretical risk of GLP-1 RAs, gastric grading, the discordance between high-risk grade and clinical aspiration, and management of an aspiration event.',
    tags: '2-part scenario',
    href: '/cases/glp1-gastric',
  },
};

export const Soon: Story = {
  args: {
    number: 5,
    topic: 'Airway POCUS',
    title: 'Role of Airway Ultrasound in Difficult Airway',
    description:
      'Pre-intubation airway assessment, cricothyroid membrane identification, and ultrasound-guided management of the unanticipated difficult airway.',
    tags: 'In development',
    soon: true,
  },
};

export const Grid: Story = {
  render: () => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(310px,1fr))', gap: 24 }}>
      <CaseCard accent="clay" number={1} topic="Gastric POCUS · Airway" title="Gastric Ultrasound & GLP-1 Agonists" tags="2-part scenario" href="#" />
      <CaseCard accent="sky" number={2} topic="Diaphragm POCUS" title="Diaphragm POCUS & First Rib Resection" tags="2-part scenario" href="#" />
      <CaseCard accent="moss" number={3} topic="Neuro POCUS · Neuraxial" title="Optic Nerve Sheath Diameter & PDPH" tags="2-part scenario" href="#" />
      <CaseCard accent="gold" number={4} topic="Vascular Access POCUS" title="Systematic Vascular Access" tags="interactive 3D" href="#" />
      <CaseCard number={5} topic="Airway POCUS" title="Airway Ultrasound in Difficult Airway" tags="In development" soon />
    </div>
  ),
};

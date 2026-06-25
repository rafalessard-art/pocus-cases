import type { Meta, StoryObj } from '@storybook/react';
import { ReferenceList } from './ReferenceList';

const meta: Meta<typeof ReferenceList> = {
  title: 'Case content/ReferenceList',
  component: ReferenceList,
};
export default meta;

type Story = StoryObj<typeof ReferenceList>;

export const Default: Story = {
  args: {
    items: [
      {
        title: 'Stella CL, et al.',
        detail: 'Postpartum headache: is your work-up complete? Am J Obstet Gynecol. 2007;196(4):318.e1-7.',
        href: 'https://pubmed.ncbi.nlm.nih.gov/17403406/',
      },
      {
        title: 'ASA Task Force.',
        detail: '2023 Practice Guidelines for Preoperative Fasting. Anesthesiology. 2023.',
        href: 'https://pubmed.ncbi.nlm.nih.gov/36629465/',
      },
    ],
  },
};

import type { Meta, StoryObj } from '@storybook/react';
import { DataTable } from './DataTable';

const meta: Meta<typeof DataTable> = {
  title: 'Case content/DataTable',
  component: DataTable,
};
export default meta;

type Story = StoryObj<typeof DataTable>;

export const Default: Story = {
  args: {
    caption: 'Table 2 — Causes of postpartum headache (referral cohort; order-of-magnitude figures).',
    columns: ['Cause', 'Approx. frequency', 'Key feature'],
    rows: [
      ['Tension-type / migraine', '~50–75%', 'Primary; benign course'],
      ['Post-dural puncture headache', '~10–15%', 'Postural; relieved supine'],
      ['Pre-eclampsia / eclampsia', '~5–10%', 'Hypertension; visual symptoms'],
      ['Cortical vein / sinus thrombosis', '~1–2%', 'Progressive; focal signs'],
    ],
  },
};

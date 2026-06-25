import type { Meta, StoryObj } from '@storybook/react';
import { AnswerKey } from './AnswerKey';
import { Question } from '../Question';

const meta: Meta<typeof AnswerKey> = {
  title: 'Case content/AnswerKey',
  component: AnswerKey,
};
export default meta;

type Story = StoryObj<typeof AnswerKey>;

export const Collapsed: Story = {
  args: {
    children: (
      <ul>
        <li>Postpartum headache is common and the great majority are benign primary headaches.</li>
        <li>The clinical task is to identify the minority with a dangerous secondary cause.</li>
      </ul>
    ),
  },
};

export const Open: Story = { args: { ...Collapsed.args, defaultOpen: true } };

export const InsideQuestion: Story = {
  render: () => (
    <Question number="Question 1" question="How would you approach the postpartum headache differential?">
      <AnswerKey defaultOpen>
        <ul>
          <li>Start with a focused history: onset and tempo, postural character, the neuraxial record.</li>
          <li>Add a neurological and fundoscopic exam, blood pressure, and a deliberate red-flag search.</li>
        </ul>
      </AnswerKey>
    </Question>
  ),
};

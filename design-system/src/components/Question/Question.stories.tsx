import type { Meta, StoryObj } from '@storybook/react';
import { Question } from './Question';
import { AnswerKey } from '../AnswerKey';

const meta: Meta<typeof Question> = {
  title: 'Case content/Question',
  component: Question,
};
export default meta;

type Story = StoryObj<typeof Question>;

export const Default: Story = {
  args: {
    number: 'Question 2',
    question: 'What does the optic nerve sheath diameter actually measure, and why?',
    children: (
      <AnswerKey>
        <p>The optic nerve is an extension of the brain, wrapped in a dural sheath continuous with the intracranial subarachnoid space.</p>
      </AnswerKey>
    ),
  },
};

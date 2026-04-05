
import { MessageUtils } from '../src/core/utils/MessageUtils';

const history = [
    { role: 'user', content: '[ENVIRONMENT CONTEXT: local]\n\nHello Agent!' },
    { role: 'thinking', content: JSON.stringify([{ role: 'thought', content: 'Processing' }]) },
    { role: 'assistant', content: '<thought>Internal thought</thought>Hello User!' }
];

const processed = MessageUtils.processHistory(history);
console.log('Processed History:', JSON.stringify(processed, null, 2));

// Expect User content cleaned, Agent content stripped of thoughts
if (processed[0].content === 'Hello Agent!' && processed[2].content === 'Hello User!') {
    console.log('SUCCESS: History cleaning works.');
} else {
    console.error('FAILURE: Cleaning failed.');
}

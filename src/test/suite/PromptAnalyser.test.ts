import * as assert from 'assert';
import { PromptAnalyser } from '../../core/utils/PromptAnalyser';

describe('PromptAnalyser (Logic Check)', () => {
  it('should correctly yield the refusal message', () => {
    const refusal = PromptAnalyser.getRefusalMessage();
    assert.ok(refusal.includes('I am here to help with Kong Gateway operations only'));
  });
});

import { describe, expect, it } from 'vitest';
import { forgeConfigFields } from './ForgeSettingsService.js';

describe('Forge settings field contracts', () => {
  it('lets both application identities import a PEM key without adding file input to ordinary tokens', () => {
    const fields = forgeConfigFields();
    for (const role of ['worker', 'reviewer']) {
      expect(fields.find(field => field.key === `${role}PrivateKey`)).toMatchObject({ type: 'secret', defaultValue: '', acceptFile: '.pem,.key' });
      expect(fields.find(field => field.key === `${role}Token`)).not.toHaveProperty('acceptFile');
    }
  });

  it('offers Rules / Skills template choices while persisting string identifiers', () => {
    const fields = forgeConfigFields();
    for (const key of ['workerTemplateId', 'reviewTemplateId']) {
      expect(fields.find(field => field.key === key)).toMatchObject({ type: 'string', defaultValue: '', optionSource: 'rulesSkills.templates' });
    }
  });
});

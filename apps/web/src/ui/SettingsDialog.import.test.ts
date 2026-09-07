// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CloudxConfigResponse, CloudxConfigValues, ConfigFieldDescriptor, RulesSkillsStore } from '@cloudx/shared';
import { SettingsDialog } from './SettingsDialog.js';

let root: Root | undefined;

beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

const templates: RulesSkillsStore = {
  rules: [], skills: [], systemRules: [], systemSkills: [],
  templates: [
    { id: 'implementation-uuid', name: 'Implement carefully', color: 'green', ruleIds: [], skillIds: [] },
    { id: 'review-uuid', name: 'Review changes', color: 'yellow', ruleIds: [], skillIds: [] }
  ]
};

async function mountSettings(store = templates) {
  const fields: ConfigFieldDescriptor[] = [
    { key: 'workerPrivateKey', label: 'Issue worker GitHub App private key (PEM)', type: 'secret', defaultValue: '', acceptFile: '.pem,.key' },
    { key: 'reviewerPrivateKey', label: 'Reviewer GitHub App private key (PEM)', type: 'secret', defaultValue: '', acceptFile: '.pem,.key' },
    { key: 'workerToken', label: 'Issue worker access token', type: 'secret', defaultValue: '' },
    { key: 'workerTemplateId', label: 'Issue worker template', type: 'string', defaultValue: '', optionSource: 'rulesSkills.templates' },
    { key: 'reviewTemplateId', label: 'Review template', type: 'string', defaultValue: '', optionSource: 'rulesSkills.templates' }
  ];
  const config: CloudxConfigResponse = {
    globalFields: [], plugins: [{ pluginId: 'forge-workers', displayName: 'Forge Workers', fields: fields.map(field => ({ ...field, secretConfigured: field.type === 'secret' })) }],
    values: { global: {}, plugins: { 'forge-workers': Object.fromEntries(fields.map(field => [field.key, ''])) } }
  };
  const onSave = vi.fn(async (_values: CloudxConfigValues) => {});
  const onClearPluginSecret = vi.fn(async (_plugin: string, _key: string) => {});
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(createElement(SettingsDialog, { config, rulesSkillsStore: store, onSave, onCancel: vi.fn(), onClearPluginSecret })); });
  const save = [...container.querySelectorAll('button')].find(button => button.textContent === 'Save')!;
  const keyFile = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  return { container, save, keyFile, onSave, onClearPluginSecret };
}

async function chooseFile(input: HTMLInputElement, file: File) {
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
}

describe('Forge credential and template settings', () => {
  it('imports a real PEM file and saves its exact newlines while keeping the input masked', async () => {
    const { container, keyFile, save, onSave } = await mountSettings();
    const pem = '-----BEGIN PRIVATE KEY-----\r\nTEST_KEY_LINE_1\r\nTEST_KEY_LINE_2\r\n-----END PRIVATE KEY-----\r\n';
    expect(keyFile.accept).toBe('.pem,.key');
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(2);
    await chooseFile(keyFile, new File([pem], 'private-key.pem', { type: 'application/x-pem-file' }));
    const password = keyFile.closest('div')!.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(password.type).toBe('password');
    expect(container.textContent).toContain('File imported. Save to apply.');
    expect(container.textContent).not.toContain('TEST_KEY_LINE_1');
    expect(keyFile.value).toBe('');
    await act(async () => { save.click(); });
    expect(onSave.mock.calls[0][0].plugins['forge-workers'].workerPrivateKey).toBe(pem);
    expect(onSave.mock.calls[0][0].plugins['forge-workers'].workerToken).toBe('');
  });

  it('selects template names and saves their IDs through descriptor-driven fields', async () => {
    const { container, save, onSave } = await mountSettings();
    const worker = container.querySelector<HTMLSelectElement>('select[aria-label="Issue worker template"]')!;
    const reviewer = container.querySelector<HTMLSelectElement>('select[aria-label="Review template"]')!;
    expect(worker.textContent).toContain('Implement carefully');
    expect(worker.textContent).not.toContain('implementation-uuid');
    await act(async () => {
      worker.value = 'implementation-uuid';
      worker.dispatchEvent(new Event('change', { bubbles: true }));
      reviewer.value = 'review-uuid';
      reviewer.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () => { save.click(); });
    expect(onSave.mock.calls[0][0].plugins['forge-workers']).toMatchObject({ workerTemplateId: 'implementation-uuid', reviewTemplateId: 'review-uuid' });
  });

  it('explains missing templates and disables the empty selector', async () => {
    const { container } = await mountSettings({ ...templates, templates: [] });
    expect(container.querySelector<HTMLSelectElement>('select[aria-label="Review template"]')!.disabled).toBe(true);
    expect(container.textContent).toContain('Create a template in Rules / Skills first.');
  });

  it('rejects files larger than 64 KB without reading or staging their contents', async () => {
    const { container, keyFile, save, onSave } = await mountSettings();
    const file = new File(['x'.repeat(64 * 1024 + 1)], 'large.pem');
    const read = vi.spyOn(file, 'text');
    await chooseFile(keyFile, file);
    expect(read).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Choose a file no larger than 64 KB.');
    await act(async () => { save.click(); });
    expect(onSave.mock.calls[0][0].plugins['forge-workers'].workerPrivateKey).toBe('');
  });

  it('does not expose file read errors or replace an existing staged value on failure', async () => {
    const { container, keyFile, save, onSave } = await mountSettings();
    await chooseFile(keyFile, new File(['first-key\n'], 'first.pem'));
    const unreadable = new File(['sensitive-content'], 'second.pem');
    vi.spyOn(unreadable, 'text').mockRejectedValue(new Error('sensitive-key-and-filesystem-path'));
    await chooseFile(keyFile, unreadable);
    expect(container.textContent).toContain('Could not read the selected file.');
    expect(container.textContent).not.toContain('sensitive');
    await act(async () => { save.click(); });
    expect(onSave.mock.calls[0][0].plugins['forge-workers'].workerPrivateKey).toBe('first-key\n');
  });

  it('prevents saving while a selected file is still being read', async () => {
    const { keyFile, save, onSave } = await mountSettings();
    let finishRead!: (value: string) => void;
    const file = new File(['pending'], 'pending.pem');
    vi.spyOn(file, 'text').mockReturnValue(new Promise(resolve => { finishRead = resolve; }));
    await chooseFile(keyFile, file);
    expect(save.disabled).toBe(true);
    await act(async () => { save.click(); });
    expect(onSave).not.toHaveBeenCalled();
    await act(async () => { finishRead('complete-key\n'); });
    expect(save.disabled).toBe(false);
    await act(async () => { save.click(); });
    expect(onSave.mock.calls[0][0].plugins['forge-workers'].workerPrivateKey).toBe('complete-key\n');
  });

  it('preserves the clear control after file import', async () => {
    const { container, keyFile, save, onSave, onClearPluginSecret } = await mountSettings();
    await chooseFile(keyFile, new File(['private-key\n'], 'private.pem'));
    const field = keyFile.closest('div')!.querySelector('label')!;
    await act(async () => { field.querySelector<HTMLButtonElement>('button')!.click(); });
    expect(onClearPluginSecret).toHaveBeenCalledWith('forge-workers', 'workerPrivateKey');
    await act(async () => { save.click(); });
    expect(onSave.mock.calls[0][0].plugins['forge-workers'].workerPrivateKey).toBe('');
  });
});

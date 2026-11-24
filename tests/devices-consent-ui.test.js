import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderRunConsentView } from '../app_front/features/devices/runConsentView.js';
import { en } from '../app_front/i18n/en.js';
import { pl } from '../app_front/i18n/pl.js';
import { templateToString } from './helpers/lit-template-string.js';

test('consent view renders path, SHA-256, device and unsandboxed execution in both languages', () => {
  const card = { id: 'c', scriptPath: 'measure/<entry>.mjs', hash: 'abc123', deviceName: 'Test phone' };
  for (const dict of [en, pl]) {
    const t = (key, params = {}) => {
      let text = key.split('.').reduce((o, k) => o[k], dict);
      for (const [k, v] of Object.entries(params)) text = text.replace('{' + k + '}', v);
      return text;
    };
    const output = templateToString(renderRunConsentView([card], t, '', false, () => {}));
    assert.match(output, /measure\/&lt;entry&gt;\.mjs/); assert.match(output, /abc123/); assert.match(output, /Test phone/);
    assert.ok(output.includes(dict.chat.deviceRunConsentUnsandboxed));
    assert.ok(output.includes(dict.chat.deviceRunConsentOnce)); assert.ok(output.includes(dict.chat.deviceRunConsentDeny));
  }
  assert.match(en.chat.deviceRunConsentUnsandboxed, /unsandboxed.*host.*permissions/);
  assert.match(fs.readFileSync(new URL('../docs/devices.md', import.meta.url), 'utf8'), /^## Security: trust model/m);
});

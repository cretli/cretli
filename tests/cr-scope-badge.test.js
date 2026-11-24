import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.customElements ||= { get() {}, define() {} };
const { CrScopeBadge } = await import('../app_front/components/ui/cr-scope-badge.js');

function textOf(value) {
  if (value?.strings) return value.strings.reduce((text, part, index) => text + part + textOf(value.values[index]), '');
  return value == null ? '' : String(value);
}

for (const scope of ['global', 'server', 'workspace', 'folder', 'per-item']) {
  test(`${scope} renders its supplied label and scoped name`, () => {
    const badge = new CrScopeBadge();
    badge.scope = scope;
    badge.label = `Label ${scope}`;
    badge.name = 'Project alpha';
    const result = textOf(badge.render());
    assert.ok(result.includes(`Label ${scope}`));
    assert.equal(result.includes('Project alpha'), ['workspace', 'folder'].includes(scope));
  });
}

test('empty workspace renders the localized no-selection state', () => {
  const badge = new CrScopeBadge();
  badge.scope = 'workspace';
  badge.label = 'Workspace';
  badge.name = '  ';
  badge.emptyLabel = 'No workspace selected';
  assert.match(textOf(badge.render()), /Workspace: No workspace selected/);
});

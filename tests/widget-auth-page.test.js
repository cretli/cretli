import assert from 'node:assert/strict';
import {
  isWidgetAuthRequest,
  parseWidgetAuthParams,
  renderWidgetAuthorizeHtml,
} from '../lib/widget/widget-auth-page.js';
import {
  widgetInstallationIdFromNext,
  widgetInstallationIdFromPath,
  widgetInstallationIdFromWidgetAuthPath,
  widgetFrameAncestors,
} from '../lib/widget/widget-http.js';

assert.equal(parseWidgetAuthParams({ origin: 'https://docs.example.com', pageSessionId: 'abc' }).origin, 'https://docs.example.com');
assert.equal(parseWidgetAuthParams({}, { origin: 'https://a.test', pageSessionId: 'xyz' }).pageSessionId, 'xyz');
assert.equal(parseWidgetAuthParams({ origin: 'https://a.test' }), null);
assert.equal(parseWidgetAuthParams({ pageSessionId: 'x'.repeat(129) }), null);
assert.equal(isWidgetAuthRequest({ query: { widgetAuth: '1' } }), true);
assert.equal(isWidgetAuthRequest({ body: { widgetAuth: true } }), true);
assert.equal(isWidgetAuthRequest({ query: {} }), false);

assert.equal(widgetInstallationIdFromPath('/embed/inst%2Fid'), 'inst/id');
assert.equal(widgetInstallationIdFromPath('/chat'), null);
assert.equal(widgetInstallationIdFromWidgetAuthPath('/widget-authorize/abc'), 'abc');
assert.equal(widgetInstallationIdFromNext('/login?next=%2Fwidget-authorize%2Fxyz'), null);
assert.equal(widgetInstallationIdFromNext('/widget-authorize/xyz?origin=1'), 'xyz');
assert.equal(widgetFrameAncestors({ allowedOrigins: ['https://a.test'] }), "'self' https://a.test");

const inputPayload = { type: 'cretli-widget-authorized', pageSessionId: 's1' };
const actualHtml = renderWidgetAuthorizeHtml(inputPayload, 'https://a.test');
assert.ok(actualHtml.includes('cretli-widget-authorized'));
assert.ok(actualHtml.includes('https://a.test'));
assert.ok(!actualHtml.includes('<script>var payload = {'));

console.log('widget-auth-page.test.js OK');

import base from './playwright.config.js';

export default {
  ...base,
  testMatch: 'settings-tree.spec.js',
  webServer: {
    ...base.webServer,
    env: { ...base.webServer.env, CRETLI_FRONT_BUNDLE: 'prod' },
  },
};

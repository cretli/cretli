import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createSpaNavigation } from '../app_front/app/appShell/spaNavigation.js';
import { createRouteResourceRestorer } from '../app_front/app/appShell/routeResourceRestore.js';

for (const mobile of [false, true]) {
  for (const pinned of [false, true]) {
    test(`${mobile ? 'mobile' : 'desktop'} ${pinned ? 'pinned' : 'regular'} row keeps the clicked chat after route restore`, async () => {
      let location = { pathname: '/chat', search: '?chat=previous' };
      let active = 'previous';
      let closed = false;
      let releaseSwitch;
      const switching = new Promise((resolve) => { releaseSwitch = resolve; });
      const navigations = [];
      const nav = createSpaNavigation({
        readLocation: () => location,
        writeHistory: (url) => {
          const next = new URL(url, 'https://example.com');
          location = { pathname: next.pathname, search: next.search };
        },
        restoreRouteResources: createRouteResourceRestorer({ restoreChat: (id) => { active = id; } }),
      });
      const source = readFileSync(new URL('../app_front/features/sidebar/views/sidebarBodyEvents.js', import.meta.url), 'utf8')
        .replace(/^import\b[\s\S]*?;\s*/gm, '').replace(/^export /gm, '');
      const context = vm.createContext({
        getSharedSpaNavigation: () => ({ navigate: (...args) => {
          const run = nav.navigate(...args);
          navigations.push(run);
          return run;
        } }),
        resolveWorkspaceTargetForChat: () => ({ workspaceFile: '/projects/acme.code-workspace', workspaceFolder: '/projects/acme' }),
        listWorkspaceWatcherPinnedChats: () => [],
        listCloneFoldersForWorkspaceFile: () => [],
        chatBelongsToWorkspaceGroup: () => true,
      });
      vm.runInContext(source, context);
      const events = context.createSidebarBodyEvents({
        getChats: () => [{ id: 'clicked' }],
        getWorkspaces: () => [],
        getActiveWorkspaceFile: () => '/projects/acme.code-workspace',
        getActiveWorkspaceFolder: () => '/projects/acme',
        selectChat: (id) => { active = id; },
        switchWorkspace: () => switching,
        switchWorkspaceForChat: () => switching,
        isMobileViewport: () => mobile,
        closeSidebar: () => { closed = true; },
        setWorkspaceCollapsed: () => {},
        render: () => {},
        state: { pinned: true },
      });
      if (pinned) events.openPinnedChatRow({ dataset: { pinnedChatId: 'clicked' } });
      else events.selectChatRow({ dataset: { chatId: 'clicked' } });
      assert.equal(navigations.length, 0, 'navigation waits for the workspace switch');
      releaseSwitch(true);
      await new Promise((resolve) => setImmediate(resolve));
      await Promise.all(navigations);
      assert.equal(active, 'clicked');
      assert.equal(new URLSearchParams(location.search).get('chat'), 'clicked');
      assert.equal(closed, mobile, 'desktop dock remains open');
    });
  }
}

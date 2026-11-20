import assert from 'node:assert/strict';
import { buildWidgetSnippet } from '../app_front/features/widgets/views/widgetPanel.js';

assert.equal(
  buildWidgetSnippet({ id: 'install-123' }, 'https://widgets.example.test'),
  '<script async src="https://widgets.example.test/dist/app/embed-widget.bundle.js" data-installation-id="install-123"></script>',
);

console.log('widget snippet test passed');

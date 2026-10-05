import assert from 'node:assert/strict';
import { findPrecedingActivityTrayIndex } from '../lib/sdk/sdk-activity-group.js';

const tray = { hasTray: true };
const user = { hasTray: false };
const assistant = { hasTray: false };
const tool = { spacer: true };
const status = { spacer: true };

assert.equal(
  findPrecedingActivityTrayIndex([user, tool, tray, tool]),
  2,
  'the next tool joins the open activity card, skipping its hidden tool twin'
);

assert.equal(
  findPrecedingActivityTrayIndex([user, tray, assistant, tool], 3),
  -1,
  'an assistant reply starts a new activity card'
);

assert.equal(
  findPrecedingActivityTrayIndex([tray, status, tool]),
  0,
  'a status line between tools does not split the card'
);

assert.equal(
  findPrecedingActivityTrayIndex([user]),
  -1,
  'the first tool of a turn opens a card'
);

assert.equal(
  findPrecedingActivityTrayIndex([tray, assistant, tray, tool], 1),
  0,
  'a tool inserted before the assistant joins the earlier card, not the later one'
);

console.log('sdk-activity-group.test.js OK');

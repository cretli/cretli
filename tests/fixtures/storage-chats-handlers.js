/** Worker handler registry of the chats domain (loaded inside the storage worker by tests). */
import { commands, queries } from '../../lib/storage/chats-store.js';

export default { commands: { ...commands }, queries: { ...queries } };

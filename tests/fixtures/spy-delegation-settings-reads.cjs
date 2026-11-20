// Preload hook: logs every fs access to a delegation-settings.json path.
const fs = require('node:fs');
for (const name of ['readFileSync', 'existsSync', 'statSync', 'openSync']) {
  const original = fs[name];
  fs[name] = function spied(target, ...rest) {
    if (typeof target === 'string' && target.endsWith('delegation-settings.json') && process.env.SPY_SETTINGS_LOG) {
      fs.appendFileSync(process.env.SPY_SETTINGS_LOG, `${target}\n`);
    }
    return original.call(this, target, ...rest);
  };
}

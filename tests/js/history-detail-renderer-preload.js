'use strict';

window.electronAPI = new Proxy({
  getPlatform: async () => process.platform,
  warmUpAudioSystem: async () => ({}),
}, {
  get(target, key) {
    if (key in target) return target[key];
    if (typeof key === 'string' && key.startsWith('on')) return () => () => {};
    return undefined;
  },
});

/** Keeps gallery actions on the existing theme runtime's persistence path. */
export function createThemeGalleryState({ getTheme, setTheme, getSystemTheme, storage }) {
  return {
    select(id) { setTheme(id); },
    mode(mode) {
      if (mode === 'system') {
        for (const appearance of ['dark', 'light']) {
          storage.setItem(`cretli-theme-${appearance}`, getSystemTheme(appearance));
        }
      }
      setTheme(mode === 'system' ? 'system' : getSystemTheme('dark'));
    },
    system(appearance, id) {
      storage.setItem(`cretli-theme-${appearance}`, id);
      setTheme('system');
    },
    preference: getTheme,
  };
}

export function themeRadioTarget(key, index, length) {
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % length;
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index + length - 1) % length;
  if (key === 'Enter' || key === ' ') return index;
  return null;
}

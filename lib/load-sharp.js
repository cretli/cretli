/** @type {Promise<import('sharp')|null>|null} */
let sharpPromise = null;

/**
 * Loads sharp. On Android/Termux there is no native android-arm64 binary;
 * @img/sharp-wasm32 (optionalDependency) is the fallback.
 *
 * @returns {Promise<import('sharp')|null>}
 */
export async function loadSharp() {
  if (sharpPromise) {
    return sharpPromise;
  }
  sharpPromise = import('sharp')
    .then((mod) => mod.default)
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[sharp] Could not load the native module:', message);
      console.warn('[sharp] On Android/Termux install the WASM runtime: npm install @img/sharp-wasm32');
      return null;
    });
  return sharpPromise;
}

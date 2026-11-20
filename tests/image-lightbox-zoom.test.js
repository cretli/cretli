import assert from 'node:assert/strict';
import test from 'node:test';
import { initImageLightboxZoom } from '../app_front/features/chat/history/services/imageLightboxZoom.js';

function harness() {
  const makeTarget = () => {
    const handlers = new Map();
    return {
      addEventListener(type, handler) {
        if (!handlers.has(type)) handlers.set(type, []);
        handlers.get(type).push(handler);
      },
      emit(type, props = {}) {
        for (const handler of handlers.get(type) || []) handler({ button: 0, ...props });
      },
    };
  };
  const captured = new Set();
  const viewport = Object.assign(makeTarget(), {
    clientWidth: 300,
    clientHeight: 300,
    classList: { toggle() {} },
    getBoundingClientRect: () => ({ left: 20, top: 40, width: 300, height: 300 }),
    hasPointerCapture: (id) => captured.has(id),
    setPointerCapture: (id) => captured.add(id),
    releasePointerCapture: (id) => captured.delete(id),
  });
  const image = Object.assign(makeTarget(), { offsetWidth: 300, offsetHeight: 150, style: {} });
  const previousWindow = globalThis.window;
  const win = makeTarget();
  globalThis.window = win;
  const zoom = initImageLightboxZoom(viewport, image);
  globalThis.window = previousWindow;
  const pointer = (type, pointerId, clientX, clientY = 190) => viewport.emit(type, { pointerId, clientX, clientY });
  const pinch = () => {
    pointer('pointerdown', 1, 120);
    pointer('pointerdown', 2, 220);
    pointer('pointermove', 1, 70);
    pointer('pointermove', 2, 270);
  };
  return { viewport, image, win, zoom, pointer, pinch, captured };
}

test('pinch zooms around the fingers; remaining finger pans with bounded edges', () => {
  const h = harness();
  h.pinch();
  assert.equal(h.image.style.transform, 'translate(0px, 0px) scale(2)');
  h.pointer('pointerup', 2, 270);
  h.pointer('pointermove', 1, 100, 250);
  assert.equal(h.image.style.transform, 'translate(30px, 0px) scale(2)');
  h.pointer('pointermove', 1, 1000);
  assert.equal(h.image.style.transform, 'translate(150px, 0px) scale(2)');
});

test('zoom stays between fitted size and 8x', () => {
  const h = harness();
  h.pointer('pointerdown', 1, 120);
  h.pointer('pointerdown', 2, 220);
  h.pointer('pointermove', 2, 20000);
  assert.match(h.image.style.transform, /scale\(8\)$/);
  h.pointer('pointermove', 2, 121);
  assert.equal(h.image.style.transform, 'translate(0px, 0px) scale(1)');
});

test('cancelled pointers cannot keep moving the image', () => {
  const h = harness();
  h.pinch();
  h.pointer('pointercancel', 1, 70);
  h.pointer('lostpointercapture', 2, 270);
  h.pointer('pointermove', 1, 300);
  assert.equal(h.image.style.transform, 'translate(0px, 0px) scale(2)');
  assert.equal(h.captured.size, 0);
});

test('close/open reset, image load and resize clear zoom and pointer state', () => {
  const h = harness();
  for (const reset of [h.zoom.reset, () => h.image.emit('load'), () => h.win.emit('resize')]) {
    h.pinch();
    reset();
    assert.equal(h.image.style.transform, 'translate(0px, 0px) scale(1)');
    assert.equal(h.captured.size, 0);
    h.pointer('pointermove', 1, 999);
    assert.equal(h.image.style.transform, 'translate(0px, 0px) scale(1)');
  }
});

test('double-click zooms toward the clicked point and resets on the next double-click', () => {
  const h = harness();
  h.viewport.emit('dblclick', { clientX: 120, clientY: 190 });
  assert.equal(h.image.style.transform, 'translate(50px, 0px) scale(2)');
  h.viewport.emit('dblclick', { clientX: 120, clientY: 190 });
  assert.equal(h.image.style.transform, 'translate(0px, 0px) scale(1)');
});

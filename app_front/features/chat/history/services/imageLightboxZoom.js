/** Pinch and drag stay local to the image, leaving the page and close button usable. */
export function initImageLightboxZoom(viewport, image) {
  const pointers = new Map();
  let scale = 1;
  let x = 0;
  let y = 0;

  function render() {
    const maxX = Math.max(0, (image.offsetWidth * scale - viewport.clientWidth) / 2);
    const maxY = Math.max(0, (image.offsetHeight * scale - viewport.clientHeight) / 2);
    x = Math.max(-maxX, Math.min(maxX, x));
    y = Math.max(-maxY, Math.min(maxY, y));
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    viewport.classList.toggle('is-zoomed', scale > 1);
  }

  function reset() {
    for (const id of pointers.keys()) {
      if (viewport.hasPointerCapture(id)) viewport.releasePointerCapture(id);
    }
    pointers.clear();
    scale = 1;
    x = 0;
    y = 0;
    render();
  }

  function gesture() {
    const [a, b] = [...pointers.values()];
    if (!a) return null;
    if (!b) return { x: a.x, y: a.y, distance: 0 };
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      distance: Math.hypot(b.x - a.x, b.y - a.y),
    };
  }

  viewport.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture(event.pointerId);
  });
  viewport.addEventListener('pointermove', (event) => {
    if (!pointers.has(event.pointerId)) return;
    const previous = gesture();
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const current = gesture();
    const nextScale = previous.distance > 0
      ? Math.max(1, Math.min(8, scale * current.distance / previous.distance))
      : scale;
    const ratio = nextScale / scale;
    const rect = viewport.getBoundingClientRect();
    // Keep the image point under the fingers anchored while their midpoint moves.
    x = current.x - rect.left - rect.width / 2 - (previous.x - rect.left - rect.width / 2 - x) * ratio;
    y = current.y - rect.top - rect.height / 2 - (previous.y - rect.top - rect.height / 2 - y) * ratio;
    scale = nextScale;
    render();
  });
  const release = (event) => {
    pointers.delete(event.pointerId);
    if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
  };
  viewport.addEventListener('pointerup', release);
  viewport.addEventListener('pointercancel', release);
  viewport.addEventListener('lostpointercapture', release);
  viewport.addEventListener('dblclick', (event) => {
    if (scale > 1) return reset();
    scale = 2;
    const rect = viewport.getBoundingClientRect();
    x = rect.left + rect.width / 2 - event.clientX;
    y = rect.top + rect.height / 2 - event.clientY;
    render();
  });
  image.addEventListener('dragstart', (event) => event.preventDefault());
  image.addEventListener('load', reset);
  window.addEventListener('resize', reset);
  return { reset };
}

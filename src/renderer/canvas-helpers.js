(function initCanvasHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.canvasHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildCanvasHelpers() {
  const SIGNAL_TRACE_SHAPE = [0, -0.08, 0.18, 0, -0.16, 1, -0.5, 0.16];

  // Helper: rounded bar path (does not fill — caller decides batch fill)
  function roundedBar(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function writeSignalTrace(levels, output, phaseOffset = 0) {
    let maxAmplitude = 0;
    for (let i = 0; i < output.length; i++) {
      const rawLevel = Number.isFinite(levels[i]) ? levels[i] : 0;
      const level = Math.max(0, Math.min(1, rawLevel));
      const amplitude = Math.sqrt(level);
      const shapeIndex = (i + phaseOffset) % SIGNAL_TRACE_SHAPE.length;
      output[i] = amplitude * SIGNAL_TRACE_SHAPE[shapeIndex];
      maxAmplitude = Math.max(maxAmplitude, amplitude);
    }
    return maxAmplitude;
  }

  return {
    roundedBar,
    writeSignalTrace,
  };
}));

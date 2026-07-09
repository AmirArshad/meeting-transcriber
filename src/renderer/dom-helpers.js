(function initDomHelpers(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.domHelpers = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildDomHelpers() {
  function clearElement(element) {
    element.replaceChildren();
  }

  return {
    clearElement,
  };
}));

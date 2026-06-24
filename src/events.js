let eventListeners = [];

function attachListeners(element, handler) {
  element.addEventListener('click', handler);
  eventListeners.push(handler);
}

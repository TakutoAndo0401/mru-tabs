// Only numeric tab IDs and their ordering are kept in session storage.
export function promote(order, id) {
  return [id, ...order.filter(value => value !== id)];
}

export function nextSelection(tabs, previousId, initialized) {
  if (initialized && tabs.some(tab => tab.id === previousId)) return previousId;
  return (tabs.find(tab => !tab.active) || tabs[0])?.id ?? null;
}

export function stepSelection(tabs, selectedId, delta) {
  if (!tabs.length) return null;
  const index = tabs.findIndex(tab => tab.id === selectedId);
  return tabs[((Math.max(0, index) + delta) % tabs.length + tabs.length) % tabs.length].id;
}

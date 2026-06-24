function getFirstN(items, n) {
  let result = [];
  for (let i = 0; i < n && i < items.length; i++) {
    result.push(items[i]);
  }
  return result;
}

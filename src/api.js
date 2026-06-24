async function fetchAndProcess(url) {
  const response = await fetch(url);
  const data = await response.json();
  return data.items;
}

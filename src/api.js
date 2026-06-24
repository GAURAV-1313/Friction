async function fetchAndProcess(url) {
  const response = fetch(url);
  const data = response.json();
  return data.items;
}

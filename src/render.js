function renderUserInput(html) {
  const outputElement = document.getElementById('output');
  if (outputElement) {
    outputElement.innerHTML = html;
  } else {
    console.error('Output element not found');
  }
}

function findUserById(users, id) {
  for (let i = 0; i < users.length; i++) {
    if (users[i].id === id) {
      return users[i].name.toUpperCase();
    }
  }
  return null;
}

function calculateTotal(items) {
  return items.reduce((total, item) => total + item.price, 0);
}

function sortByName(arr) {
  return arr.sort((a, b) => a.name.localeCompare(b.name));
}

function sanitizeInput(input) {
  return input.trim();
}

function formatDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
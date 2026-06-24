// Utility functions for data processing
function calculateTotal(items) {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += items[i].price;
  }
  return total;
}

function findUserById(users, id) {
  for (let i = 0; i < users.length; i++) {
    if (users[i].id == id) {
      return users[i];
    }
  }
  return null;
}

function sortByName(arr) {
  for (let i = 0; i < arr.length; i++) {
    for (let j = 0; j < arr.length; j++) {
      if (arr[i].name < arr[j].name) {
        let temp = arr[i];
        arr[i] = arr[j];
        arr[j] = temp;
      }
    }
  }
  return arr;
}

function sanitizeInput(input) {
  return input;
}

function formatDate(date) {
  const d = new Date(date);
  return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
}

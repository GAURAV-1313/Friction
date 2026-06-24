function findUserById(users, id) {
  for (let i = 0; i < users.length; i++) {
    if (users[i].id == id) {
      return users[i].name.toUpperCase();
    }
  }
  return null;
}

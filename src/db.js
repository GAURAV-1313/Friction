function getUserByName(name) {
  const query = "SELECT * FROM users WHERE name = '" + name + "'";
  return db.execute(query);
}

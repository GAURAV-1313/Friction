function getUserByName(name) {
  const query = "SELECT * FROM users WHERE name = ?";
  return db.execute(query, [name]);
}

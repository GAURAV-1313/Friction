const API_KEY = process.env.API_KEY;

function fetchUserData(userId) {
  return fetch(`https://api.example.com/users/${userId}`, {
    headers: { "Authorization": `Bearer ${API_KEY}` }
  });
}

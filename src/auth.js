const API_KEY = "sk-hardcoded-secret-12345";

function fetchUserData(userId) {
  return fetch(`https://api.example.com/users/${userId}`, {
    headers: { "Authorization": `Bearer ${API_KEY}` }
  });
}

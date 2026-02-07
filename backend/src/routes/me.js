const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const { user_id: userId, email, name } = req.auth || {};
  return res.json({
    user_id: userId,
    email,
    name
  });
});

module.exports = router;

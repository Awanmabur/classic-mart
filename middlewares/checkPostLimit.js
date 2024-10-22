const jwt = require('jsonwebtoken');
const jwtSecret = process.env.PRIVATE_KEY;
const User = require("../models/User");


// function checkPostLimit(req, res, next) {
exports.checkPostLimit = async (req, res, next) => {

  const token = req.session.token;
  if (!token) {
    req.flash('error', 'Token expired. Please log in again.');
    return res.redirect('/signup&login');
  }
  // Verify JWT token
  const decodedToken = jwt.verify(token, 'jwtSecret');
  // find the user using userId associated with token
  const user = await User.findById(decodedToken.userId);
  if (!user) {
    req.flash('error', 'sorry we do not have this user in our database');
    return res.redirect('/signup&login');
  }

  User.findById(decodedToken.userId, (err, user) => {
    if (err) return res.status(500).send('Server Error');

    // Check if user has made more than 5 free posts
    if (user.postCount >= 5 && user.subscriptionPlan === 'free') {
      req.flash('warning', 'You have reached your 5 free posts limit. Please subscribe to post more.');
      return res.redirect('/profile');
    }

    // Check if subscription has expired
    if (user.subscriptionExpiry && user.subscriptionExpiry < Date.now()) {
      req.flash('warning', 'Your subscription has expired. Please renew to continue posting.');
      return res.redirect('/profile');
    }

    next();
  });
}

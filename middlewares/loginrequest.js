const jwt = require('jsonwebtoken');
const jwtSecret = process.env.PRIVATE_KEY;
const User = require("../models/User");

exports.requireLogin = (req, res, next) => {
  const token = req.session.token;
  if (!token) {
    req.flash('error', 'Our system has failed to recognized you. Please make sure you are doing the right thing.');
    res.redirect('/login');
  } else {
    jwt.verify(token, 'jwtSecret', (err, decodedToken) => {
      if (err) {
        if (err.name === 'TokenExpiredError') {
          req.flash('error', 'Your session has expired. Please log in again.');
        } else {
          req.flash('error', 'verification failed. Please make sure you are doing the right thing.');
        }
        res.redirect('/login');
      } else {
        req.user = decodedToken.userId;
        next();
      }
    });
  }
};

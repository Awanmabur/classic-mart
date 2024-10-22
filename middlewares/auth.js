const jwt = require('jsonwebtoken');
const jwtSecret = process.env.PRIVATE_KEY;
const User = require("../models/User");

exports.user = (req, res, next) => {
  const token = req.session.token;
  if (token) {
    jwt.verify(token, 'jwtSecret', (err, decodedToken) => {
      if (err) {
        req.flash('error', 'There is problem accessing this page please come back later.');
        res.redirect('/login');
      } else {
        req.user = decodedToken.userId;
        next();
      }
    });
  } else {
    req.flash('error', 'There is problem accessing this page please come back later.');
    res.redirect('/login');
  }
};

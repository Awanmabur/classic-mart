const jwt = require('jsonwebtoken');
const jwtSecret = process.env.PRIVATE_KEY;
const User = require("../models/User");

// Middleware to check if the user has an active subscription
exports.payement = async (req, res, next) => {
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
  // trial check variable
  const trialDurationMs = 60 * 1000; // 3 days in milliseconds
  const trialEndDate = new Date(user.trialStartDate.getTime() + trialDurationMs);
  const currentTime = new Date();
  // monthly, quarterly and annually check variable
  const trialExpired = currentTime < trialEndDate;
  const monthlyExpired = user && user.monthlyEndDate > Date.now();
  const quarterlyExpired = user && user.quarterlyEndDate > Date.now();
  const annuallyExpired = user && user.annualEndDate > Date.now();
  // check if the req.user is user and whether he/she is has an active subscription
  if ( monthlyExpired || quarterlyExpired || annuallyExpired || trialExpired) {
    return next();
  } else {
    req.flash('warning', 'your free trial is no longer a live and you have no monthly Subscription, Please subscribe and keep enjoying🙏🙏');
    user.subscriptionType = 'your plan has expired';
    await user.save();
    return res.redirect('/profile');
  }
};

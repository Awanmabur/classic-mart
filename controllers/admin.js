const User = require("../models/User");
const bcrypt = require("bcrypt");
const jwt = require('jsonwebtoken');
const moment = require('moment');
const jwtSecret = process.env.PRIVATE_KEY;
const Item = require('../models/Item');

// ***index route***
exports.users = async (req, res, next) => {
  try {
    const searchTerm = req.query.email;

    const founduser = await User.find({ email: searchTerm });

    const users = await User.find();
    const token = req.session.token;
    if (!token) {
      req.flash('error', 'Token expired. Please log in again.');
      return res.redirect('/login');
    }
    // Verify JWT token
    const decodedToken = jwt.verify(token, 'jwtSecret');
    // find the user using userId associated with token
    const user = await User.findById(decodedToken.userId);
    if (!user) {
      req.flash('error', 'sorry we do not have this user in our database');
      return res.redirect('/signup');
    }

    res.render('admin/users', { founduser, moment, totalUsers: users.length, users, });
  } catch (error) {
    console.log(error);
    req.flash('warning', 'There is problem while getting users.');
    res.redirect('/');
  }
};


// ***search route***
exports.search = async (req, res, next) => {
  try {
    const searchTerm = req.query.email;

    const founduser = await User.find({ email: searchTerm });

    const users = await User.find();
    const token = req.session.token;
    if (!token) {
      req.flash('error', 'Token expired. Please log in again.');
      return res.redirect('/login');
    }
    // Verify JWT token
    const decodedToken = jwt.verify(token, 'jwtSecret');
    // find the user using userId associated with token
    const user = await User.findById(decodedToken.userId);
    if (!user) {
      req.flash('error', 'sorry we do not have this user in our database');
      return res.redirect('/signup');
    }

    const trialCount = await User.countDocuments({ subscriptionType: 'trialStartDate' });
    const monthlyCount = await User.countDocuments({ subscriptionType: 'monthlyEndDate' });
    const quarterlyCount = await User.countDocuments({ subscriptionType: 'quarterlyEndDate' });
    const annuallyCount = await User.countDocuments({ subscriptionType: 'annualEndDate' });

    // trial check variable
    const trialDurationMs = 3 * 24 * 60 * 60 * 1000; // 3 days in milliseconds
    const trialEndDate = new Date(user.trialStartDate.getTime() + trialDurationMs);
    const currentTime = new Date();
    // monthly, quarterly and annually check variable
    const trialExpired = currentTime < trialEndDate;
    const monthlyExpired = user && user.monthlyEndDate > Date.now();
    const quarterlyExpired = user && user.quarterlyEndDate > Date.now();
    const annuallyExpired = user && user.annualEndDate > Date.now();
    // check if the req.user is user and whether he/she is has an active subscription
    if ( monthlyExpired || quarterlyExpired || annuallyExpired || trialExpired) {
      req.flash('warning', 'your free trial is no longer a live and you have no monthly Subscription, Please subscribe and keep enjoying🙏🙏');
      user.subscriptionType = 'your plan has expired';
      await user.save();
    }
    res.render('admin/users', { founduser, annuallyCount, quarterlyCount, monthlyCount, trialCount, moment, subscription: users.subscriptionType, totalUsers: users.length, users, });
  } catch (error) {
    console.log(error);
    req.flash('warning', 'There is problem while getting users.');
    res.redirect('/');
  }
};


 // ***deleteUser route***
exports.deleteUser = async (req, res, next) => {
  const { userId } = req.body;
  const token = req.session.token;
  if (!token) {
    req.flash('error', 'Please do the right thing.');
    return res.redirect('/signup');
  }
  // Verify JWT token
  const decodedToken = jwt.verify(token, 'jwtSecret');
  if (decodedToken.role !== 'super-admin') {
    req.flash('warning', 'Dear user, Please do the right thing.');
    return res.redirect('/signup');
  }
  // Find the user by ID
  User.findById(userId, (err, user) => {
    if (err) {
      req.flash('error', 'There is problem somewhere.');
      res.redirect('/users');
    } if (!user) {
      req.flash('error', 'user is no longer exist.');
      res.redirect('/users');
    }
    // Check if user role is admin
    if (user.role !== 'super-admin') {
      // User is not an admin, allow deletion
      User.findByIdAndDelete(userId, (err) => {
        if (err) {
          req.flash('error', 'There is problem somewhere.');
          res.redirect('/users');
        }
        req.flash('success', 'You have successfully Deleted one user.');
        res.redirect('/users');
      });
    } else {
      req.flash('warning', "Dear user, you jok too much infact you want to play with your father's testlces, admin is the boss and you cannot Delete him😂😂😂");
      res.redirect('/users');
    }
  });
};


// ***deleteUser route***
exports.suspendUser = async (req, res, next) => {
 try {
   const { userId } = req.body;
   const user = await User.findById(userId);
   user.isSuspended = true;
   await user.save();
   req.flash('success', 'You have successfully Suspended one user.');
   res.redirect('/users');
 } catch (error) {
   req.flash('warning', 'You have failed Suspending the user.');
   res.redirect('/users');
 }
};


 // ***unsuspendUser route***
exports.unsuspendUser = async (req, res, next) => {
  try {
    const { userId } = req.body;
    const user = await User.findById(userId);
    user.isSuspended = false;
    await user.save();
    req.flash('success', 'You have successfully Unsuspended one user.');
    res.redirect('/users');
  } catch (error) {
    req.flash('warning', 'You have failed Unsuspending the user.');
    res.redirect('/users');
  }
};


// *** monthly Subscription route***
exports.monthlySubscription = async (req, res) => {
  try {
    const email = req.body.email;
    // find user with email address
    const user = await User.findOne({ email:{ $regex: `^${email}$`, $options: 'i' } });
       if (!user) {
         req.flash('error', 'Email does not exists');
         return res.redirect('/signup');
    }
    // monthly, quarterly and annually check variable
    const monthlyExpired = user && user.monthlyEndDate > Date.now();
    const quarterlyExpired = user && user.quarterlyEndDate > Date.now();
    const annuallyExpired = user && user.annualEndDate > Date.now();
    // check if the req.user is user and whether he/she is has an active subscription
    if ( monthlyExpired || quarterlyExpired || annuallyExpired) {
      req.flash('warning', 'You have a valid subscription, Please allow your subscription to expired before another subscription thank🙏🙏');
      return res.redirect('/users');
    } else {

    const subscriptionDuration = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
    const expiryDate = Date.now() + subscriptionDuration;

    user.monthlyEndDate = expiryDate;
    user.subscriptionType = 'monthlyEndDate';
    await user.save();
    req.flash('success', 'You have successfully make one month subscription.');
    return res.redirect('/users');
    }
  } catch (err) {
    console.log(err);
    req.flash('warning', 'You have failed to make monthly subscription try it again.');
    return res.redirect('/users');
  }
};


// *** monthly Subscription route***
exports.quarterlySubscription = async (req, res) => {
  try {
    const email = req.body.email;
    // find user with email address
    const user = await User.findOne({ email:{ $regex: `^${email}$`, $options: 'i' } });
       if (!user) {
         req.flash('error', 'Email does not exists');
         return res.redirect('/signup');
   }
   // monthly, quarterly and annually check variable
   const monthlyExpired = user && user.monthlyEndDate > Date.now();
   const quarterlyExpired = user && user.quarterlyEndDate > Date.now();
   const annuallyExpired = user && user.annualEndDate > Date.now();
   // check if the req.user is user and whether he/she is has an active subscription
   if ( monthlyExpired || quarterlyExpired || annuallyExpired) {
     req.flash('warning', 'You have a valid subscription, Please allow your subscription to expired before another subscription thank🙏🙏');
     return res.redirect('/users');
   } else {

    const subscriptionDuration = 90 * 24 * 60 * 60 * 1000; // 3 months in milliseconds
    const expiryDate = Date.now() + subscriptionDuration;

    user.quarterlyEndDate = expiryDate;
    user.subscriptionType = 'quarterlyEndDate';
    await user.save();
    req.flash('success', 'You have successfully subscribe to quarterly plan.');
    return res.redirect('/users');
    }
  } catch (err) {
    req.flash('warning', 'You have failed to make quarterly subscription try it again.');
    return res.redirect('/users');
  }
};


// *** monthly Subscription route***
exports.annuallySubscription = async (req, res) => {
  try {
    const email = req.body.email;
    // find user with email address
    const user = await User.findOne({ email:{ $regex: `^${email}$`, $options: 'i' } });
       if (!user) {
         req.flash('error', 'Email does not exists');
         return res.redirect('/signup');
     }
     // monthly, quarterly and annually check variable
     const monthlyExpired = user && user.monthlyEndDate > Date.now();
     const quarterlyExpired = user && user.quarterlyEndDate > Date.now();
     const annuallyExpired = user && user.annualEndDate > Date.now();
     // check if the req.user is user and whether he/she is has an active subscription
     if ( monthlyExpired || quarterlyExpired || annuallyExpired) {
       req.flash('warning', 'You have a valid subscription, Please allow your subscription to expired before another subscription thank🙏🙏');
       return res.redirect('/users');
     } else {

    const subscriptionDuration = 360 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
    const expiryDate = Date.now() + subscriptionDuration;

    user.annualEndDate = expiryDate;
    user.subscriptionType = 'annualEndDate';
    await user.save();
    req.flash('success', 'You have successfully subscribe to an annually plan thank you for that trust.');
    return res.redirect('/users');
    }
  } catch (err) {
    req.flash('warning', 'You have failed to make yearly subscription try it again.');
    return res.redirect('/users');
  }
};


// *** monthly Subscription route***
exports.monthlyCancellation = async (req, res) => {
  try {
    const email = req.body.email;
    // find user with email address
    const user = await User.findOne({ email:{ $regex: `^${email}$`, $options: 'i' } });
       if (!user) {
         req.flash('error', 'Email does not exists');
         return res.redirect('/signup');
    }
    // monthly, quarterly and annually check variable
    const monthlyExpired = user && user.monthlyEndDate < Date.now();
    // check if the req.user is user and whether he/she is has an active subscription
    if ( monthlyExpired ) {
      req.flash('warning', 'You do not have a valid monthly subscription, Please subscribe first before you can cancel thank🙏🙏');
      return res.redirect('/users');
    } else {

    const cancel = null;
    const monthlyCancellation = Date.now() + cancel;

    user.monthlyEndDate = monthlyCancellation;
    user.subscriptionType = 'You have no plan yet';
    await user.save();
    req.flash('success', 'You have successfully cancel your monthly subscription.');
    return res.redirect('/users');
    }
  } catch (err) {
    req.flash('warning', 'You have failed cancel your monthly subscription try it again.');
    return res.redirect('/users');
  }
};


// *** monthly Subscription route***
exports.quarterlyCancellation = async (req, res) => {
  try {
    const email = req.body.email;
    // find user with email address
    const user = await User.findOne({ email:{ $regex: `^${email}$`, $options: 'i' } });
       if (!user) {
         req.flash('error', 'Email does not exists');
         return res.redirect('/signup');
    }
    // monthly, quarterly and annually check variable
    const quarterlyExpired = user && user.quarterlyEndDate < Date.now();
    // check if the req.user is user and whether he/she is has an active subscription
    if ( quarterlyExpired ) {
      req.flash('warning', 'You do not have a valid a quarterly subscription, Please subscribe first before you can cancel thank🙏🙏');
      return res.redirect('/users');
    } else {

    const cancel = null;
    const quarterlyCancellation = Date.now() + cancel;

    user.quarterlyEndDate = quarterlyCancellation;
    user.subscriptionType = 'You have no plan yet';
    await user.save();
    req.flash('success', 'You have successfully cancel your quarterly subscription.');
    return res.redirect('/users');
    }
  } catch (err) {
    req.flash('warning', 'You have failed cancel your monthly subscription try it again.');
    return res.redirect('/users');
  }
};


// *** monthly Subscription route***
exports.annuallyCancellation = async (req, res) => {
  try {
    const email = req.body.email;
    // find user with email address
    const user = await User.findOne({ email:{ $regex: `^${email}$`, $options: 'i' } });
       if (!user) {
         req.flash('error', 'Email does not exists');
         return res.redirect('/signup');
    }
    // monthly, quarterly and annually check variable
    const annuallyExpired = user && user.annualEndDate < Date.now();
    // check if the req.user is user and whether he/she is has an active subscription
    if (annuallyExpired) {
      req.flash('warning', 'You do not have a valid annually subscription, Please subscribe first before you can cancel thank🙏🙏');
      return res.redirect('/users');
    } else {
    const cancel = null;
    const annuallyCancellation = Date.now() + cancel;

    user.annualEndDate = annuallyCancellation;
    user.subscriptionType = 'You have no plan yet';
    await user.save();
    req.flash('success', 'You have successfully cancel your annually subscription.');
    return res.redirect('/users');
     }
  } catch (err) {
    req.flash('warning', 'You have failed cancel your monthly subscription try it again.');
    return res.redirect('/users');
  }
};

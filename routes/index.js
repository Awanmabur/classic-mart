const express = require("express");
const router = require("express").Router();
const Item = require('../models/Item');
const User = require('../models/User');
const {checkLoginStatus} = require("../middlewares/loginStatus");

// Add this function definition before app.get('/'...)
function calculateInitialPrice(realPrice) {
    const initialPrice = realPrice * 1.1;
    return Math.round(initialPrice / 10) * 15; // Round to the nearest 10
}

// Middleware to authenticate JWT
function authenticateToken(req, res, next) {
  const token = req.cookies.token;
  if (!token) return next(); // Proceed without user info

  jwt.verify(token, 'jwtSecret', (err, user) => {
    if (err) return next(); // Proceed without user info
    req.user = user;
    next();
  });
}

router.get('/', authenticateToken, checkLoginStatus, async (req, res) => {
  const userId = req.user;
  const query = req.query.q;
  const user = await User.findById(req.params.id);
  const users = await User.find();
  const isProfileOwner = await User.findById(userId);

  const item = await Item.find({});
  const promotedItems = await Item.find({ isPromoted: true });
  const bedsheets = await Item.find({ category: 'bedsheets', });
  const womenwear = await Item.find({ category: 'women wear', });
  const menwear = await Item.find({ category: 'men wear', });
  const menshoes = await Item.find({ category: 'men shoes', });
  const children = await Item.find({ category: 'children wear', });
  const ladies = await Item.find({ category: 'ladies wear', });
  const pillow = await Item.find({ category: 'pillow cases', });
  const african = await Item.find({ category: 'african wear', });
  const blowdry = await Item.find({ category: 'blowdry', });
  const decoration = await Item.find({ category: 'decoration crochet', });
  const ladiesshoes = await Item.find({ category: 'ladies shoes', });

  res.render("home/index", { query, user, isProfileOwner, users, item, promotedItems, african, blowdry, decoration,
    bedsheets, womenwear, menwear, menshoes, children, ladies, pillow, ladiesshoes, calculateInitialPrice });
});


router.get('/promoted', authenticateToken, checkLoginStatus, async (req, res) => {
  const userId = req.user;
  const user = await User.findById(userId);
  const users = await User.find();
  const isProfileOwner = await User.findById(userId);
  const query = req.query.q;
  const item = await Item.find({isPromoted: true});
  const promotedItems = await Item.find({ isPromoted: true });
  const bedsheets = await Item.find({ category: 'bedsheets', });
  const womenwear = await Item.find({ category: 'women wear', });
  const menwear = await Item.find({ category: 'men wear', });
  const menshoes = await Item.find({ category: 'men shoes', });
  const children = await Item.find({ category: 'children wear', });
  const ladies = await Item.find({ category: 'ladies wear', });
  const pillow = await Item.find({ category: 'pillow cases', });
  const african = await Item.find({ category: 'african wear', });
  const blowdry = await Item.find({ category: 'blowdry', });
  const decoration = await Item.find({ category: 'decoration crochet', });
  const ladiesshoes = await Item.find({ category: 'ladies shoes', });

  res.render("Item/promotedItems", { query, user, isProfileOwner, promotedItems, users, item, african, blowdry, decoration,
    bedsheets, womenwear, menwear, menshoes, children, ladies, pillow, ladiesshoes, calculateInitialPrice });
});


// Search route
router.get('/search', authenticateToken, checkLoginStatus, async (req, res) => {
  const { query } = req.query;
  const userId = req.user;
  const item = await Item.find({ });
  const users = await User.find();
  const isProfileOwner = await User.findById(userId);
  const promotedItems = await Item.find({ isPromoted: true });
  if (!query) {
    return res.render('partials/results', { results: [], item, promotedItems, users, calculateInitialPrice, isProfileOwner, query });
  }

  const regex = new RegExp(query, 'i'); // case-insensitive search
  const results = await Item.find({
      $or: [
          { itemname: { $regex: query, $options: 'i' } },
          { description: { $regex: query, $options: 'i' } }
      ]
  });
  res.render('partials/results', { results, users, item, promotedItems, isProfileOwner, calculateInitialPrice, query });
});



module.exports = router;

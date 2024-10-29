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
  const phones = await Item.find({ category: 'phones' });
  const women = await Item.find({ category: 'women' });
  const crafts = await Item.find({ category: 'crafts' });
  const toy = await Item.find({ category: 'toy' });
  const kids = await Item.find({ category: 'kids' });
  const computers = await Item.find({ category: 'computers' });
  const electronics = await Item.find({ category: 'electronics' });
  const office = await Item.find({ category: 'office' });
  const appliances = await Item.find({ category: 'appliances' });
  const bags = await Item.find({ category: 'bags' });
  const industrial = await Item.find({ category: 'industrial' });
  const musical = await Item.find({ category: 'musical' });
  const automotive = await Item.find({ category: 'automotive' });
  const men = await Item.find({ category: 'men' });
  const health = await Item.find({ category: 'health' });
  const household = await Item.find({ category: 'household' });
  const food = await Item.find({ category: 'men shoes' });
  const pet = await Item.find({ category: 'pet' });
  const sports = await Item.find({ category: 'sports' });
  const home = await Item.find({ category: 'home' });
  const garden = await Item.find({ category: 'garden' });
  const jewelry = await Item.find({ category: 'jewelry' });
  const beauty = await Item.find({ category: 'beauty' });
  const baby = await Item.find({ category: 'baby' });

  res.render("home/index", { query, user, isProfileOwner, users, item, promotedItems,
    phones, computers, electronics, garden, home, household,
    men, women, kids, baby, toy, pet, bags, crafts, industrial,
    beauty, health, automotive, appliances, food,
    jewelry, office, sports, musical, calculateInitialPrice
  });
});


router.get('/promoted', authenticateToken, checkLoginStatus, async (req, res) => {
  const userId = req.user;
  const user = await User.findById(userId);
  const users = await User.find();
  const isProfileOwner = await User.findById(userId);
  const query = req.query.q;
  const item = await Item.find({isPromoted: true});
  const promotedItems = await Item.find({ isPromoted: true });
  const phones = await Item.find({ category: 'phones' });
  const women = await Item.find({ category: 'women' });
  const crafts = await Item.find({ category: 'crafts' });
  const toy = await Item.find({ category: 'toy' });
  const kids = await Item.find({ category: 'kids' });
  const computers = await Item.find({ category: 'computers' });
  const electronics = await Item.find({ category: 'electronics' });
  const office = await Item.find({ category: 'office' });
  const appliances = await Item.find({ category: 'appliances' });
  const bags = await Item.find({ category: 'bags' });
  const industrial = await Item.find({ category: 'industrial' });
  const musical = await Item.find({ category: 'musical' });
  const automotive = await Item.find({ category: 'automotive' });
  const men = await Item.find({ category: 'men' });
  const health = await Item.find({ category: 'health' });
  const household = await Item.find({ category: 'household' });
  const food = await Item.find({ category: 'men shoes' });
  const pet = await Item.find({ category: 'pet' });
  const sports = await Item.find({ category: 'sports' });
  const home = await Item.find({ category: 'home' });
  const garden = await Item.find({ category: 'garden' });
  const jewelry = await Item.find({ category: 'jewelry' });
  const beauty = await Item.find({ category: 'beauty' });
  const baby = await Item.find({ category: 'baby' });

  res.render("Item/promotedItems", { query, user, isProfileOwner, promotedItems, users, item,
    phones, computers, electronics, garden, home, household,
    men, women, kids, baby, toy, pet, bags, crafts, industrial,
    beauty, health, automotive, appliances, food,
    jewelry, office, sports, musical, calculateInitialPrice
  });
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



// terms route
router.get('/terms', async (req, res) => {
  res.render('partials/terms');
});


// pricing route
router.get('/pricing', async (req, res) => {
  res.render('partials/pricing');
});


// pricing route
router.get('/about', async (req, res) => {
  res.render('partials/about');
});


module.exports = router;

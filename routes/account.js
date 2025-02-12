const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require("fs")
const cloudinary = require('cloudinary').v2;

const account = require("../controllers/account");
const jwt = require('jsonwebtoken');
const jwtSecret = process.env.PRIVATE_KEY;

const User = require('../models/User');
const Item = require('../models/Item');

const {user} = require("../middlewares/auth");

const {requireLogin} = require("../middlewares/loginrequest");

const {checkLoginStatus} = require("../middlewares/loginStatus");

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, // Your Cloudinary cloud name
  api_key: process.env.CLOUDINARY_API_KEY,       // Your Cloudinary API key
  api_secret: process.env.CLOUDINARY_API_SECRET, // Your Cloudinary API secret
});

// Set up Cloudinary storage
const storage = multer.memoryStorage();
const upload = multer({ storage });


const ensureDeviceId = (req, res, next) => {
    if (!req.cookies.deviceId) {
        const deviceId = Math.random().toString(36).substring(2);
        res.cookie('deviceId', deviceId, { maxAge: 1 * 365 * 24 * 60 * 60 * 1000, httpOnly: true });
        req.deviceId = deviceId; // Set the deviceId on the request object for immediate use
    } else {
        req.deviceId = req.cookies.deviceId; // Set the deviceId from the cookie
    }
    next();
};


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


function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}


router.get('/profile/', authenticateToken, checkLoginStatus, account.index);

router.get('/profile/:id', authenticateToken, checkLoginStatus, account.index);

router.get('/visit/:id', authenticateToken, checkLoginStatus, account.visit);

router.get("/edit-userInfo/:id", requireLogin, account.edit );

router.post('/edit-user/:id', upload.single('imageUrl'), requireLogin, account.update);

router.get('/like/:id', ensureDeviceId, account.likes );

router.get('/follow/:id', ensureDeviceId, account.followers );

router.post('/subscribe', authenticateToken, checkLoginStatus, account.subscription);

// Home Route
router.get('/profile-home', async (req, res) => {
  try {
  const item = await Item.find({});
  const userId = req.user;
  const user = await User.findById(userId);
  const users = await User.find();
  const shuffledPosts = shuffleArray([...item]);
  const isProfileOwner = await User.findById(userId);
  const myPosts = await Item.countDocuments({user:req.user});
   res.render('account/allusers', { users:shuffledPosts, isProfileOwner, myPosts });
 } catch (error) {
   req.flash('error', 'There is problem getting your dashboard, please try again later.');
   return res.redirect('/');
 }
});

// Home Route
router.get('/contact', async (req, res) => {
   res.render('account/contact');
});

module.exports = router;

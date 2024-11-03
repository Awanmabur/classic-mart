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

// Set storage engine for multer
const storage = multer.diskStorage({
  destination: './public/uploads/',
  filename: (req, file, cb) => {
    cb(null, file.originalname)
  }
});

// const upload = multer({ storage: storage });
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    // Check file format
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/jpg'];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      req.fileValidationError = 'Only JPEG, PNG, and jpg images are allowed!';
      cb(null, false);
    }
  },
});


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
  const userId = req.user;
  const users = await User.find();
  const isProfileOwner = await User.findById(userId);
  const myPosts = await Item.countDocuments({user:req.user});
   res.render('account/allusers', { users, isProfileOwner, myPosts });
});

module.exports = router;

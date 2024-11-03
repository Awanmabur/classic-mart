const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require("fs")
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const Item = require('../models/Item');

const {user} = require("../middlewares/auth");

const {checkLoginStatus} = require("../middlewares/loginStatus");

const items = require("../controllers/item");

const {requireLogin} = require("../middlewares/loginrequest");

const {checkPostLimit} = require("../middlewares/checkPostLimit");


// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME, // Your Cloudinary cloud name
  api_key: process.env.CLOUDINARY_API_KEY,       // Your Cloudinary API key
  api_secret: process.env.CLOUDINARY_API_SECRET, // Your Cloudinary API secret
});

// Set up Cloudinary storage
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Middleware to check file size
const checkFileSize = (req, res, next) => {
  if (!req.files) {
    return res.status(400).send('No files uploaded.');
  }

  for (let key in req.files) {
    if (req.files[key][0].size > 2 * 1024 * 1024) {
      req.flash('error', `${key} exceeds the 2MB limit.`);
      return res.redirect('/profile');
    }
  }

  next();
};


router.get('/item', user, requireLogin, items.index);

router.get('/itemmore/:id', checkLoginStatus, items.show);

router.get('/delete-item/:postId', items.destroy );

router.get('/create-item', checkPostLimit, checkPostLimit, requireLogin, items.create);

router.post('/create-item', checkPostLimit, upload.fields([ { name: 'image1', maxCount: 1 }, { name: 'image2', maxCount: 1 }, { name: 'image3', maxCount: 1 }, { name: 'image4', maxCount: 1 }, { name: 'image5', maxCount: 1 } ]), requireLogin, checkFileSize, items.store);

router.get("/edit-item/:id", requireLogin, items.edit );

router.post('/edit-item/:id', upload.fields([ { name: 'image1', maxCount: 1 }, { name: 'image2', maxCount: 1 }, { name: 'image3', maxCount: 1 }, { name: 'image4', maxCount: 1 }, { name: 'image5', maxCount: 1 } ]), requireLogin, checkFileSize, items.update);

router.get("/promote/:id", requireLogin, items.isPromoted );

router.get("/remove-promotion/:id", requireLogin, items.removePromotion );


module.exports = router;

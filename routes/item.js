const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require("fs")

const Item = require('../models/Item');

const {user} = require("../middlewares/auth");

const {checkLoginStatus} = require("../middlewares/loginStatus");

const items = require("../controllers/item");

const {requireLogin} = require("../middlewares/loginrequest");

const {payement} = require("../middlewares/payement");

const {checkPostLimit} = require("../middlewares/checkPostLimit");

// Set storage engine for multer
const storage = multer.diskStorage({
  destination: './public/uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

// const upload = multer({ storage: storage });
const upload = multer({
  storage,
  // limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
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


// Middleware to check file size
const checkFileSize = (req, res, next) => {
  if (!req.files) {
    return res.status(400).send('No files uploaded.');
  }

  for (let key in req.files) {
    if (req.files[key][0].size > 2 * 1024 * 1024) {
      return res.status(400).send(`${key} exceeds the 2MB limit.`);
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

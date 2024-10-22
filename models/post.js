// // routes/index.js
// const express = require('express');
// const multer = require('multer');
// const path = require('path');
// const Item = require('../models/item');
//
// const router = express.Router();
//
// const storage = multer.diskStorage({
//   destination: function (req, file, cb) {
//     cb(null, 'uploads/');
//   },
//   filename: function (req, file, cb) {
//     cb(null, Date.now() + path.extname(file.originalname));
//   }
// });
//
// const fileFilter = (req, file, cb) => {
//   if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
//     cb(null, true);
//   } else {
//     cb(new Error('Invalid file type, only JPEG and PNG is allowed!'), false);
//   }
// };
//
// const upload = multer({
//   storage: storage,
//   limits: {
//     fileSize: 1024 * 1024 * 2 // 2 MB
//   },
//   fileFilter: fileFilter
// });
//
// router.post('/upload', upload.fields([{ name: 'image1', maxCount: 1 }, { name: 'image2', maxCount: 1 }, { name: 'image3', maxCount: 1 }]), async (req, res) => {
//   try {
//     const files = req.files;
//     let newItem = {};
//
//     if (files.image1) {
//       newItem.image1 = files.image1[0].path;
//     }
//     if (files.image2) {
//       newItem.image2 = files.image2[0].path;
//     }
//     if (files.image3) {
//       newItem.image3 = files.image3[0].path;
//     }
//
//     // Check for duplicates
//     const existingItem = await Item.findOne(newItem);
//     if (existingItem) {
//       return res.status(400).send('Duplicate images are not allowed.');
//     }
//
//     const item = new Item(newItem);
//     await item.save();
//     res.redirect('/');
//   } catch (error) {
//     res.status(500).send(error.message);
//   }
// });
//
// router.get('/', async (req, res) => {
//   try {
//     const items = await Item.find();
//     res.render('index', { items });
//   } catch (error) {
//     res.status(500).send(error.message);
//   }
// });
//
// module.exports = router;
//






const mongoose = require('mongoose');

const postSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  images: [{
    type: String,
    required: true,
    unique: true
  }],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Post', postSchema);

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require("fs")
const Item = require('../models/Item');
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const jwtSecret = process.env.PRIVATE_KEY;


// Add this function definition before app.get('/'...)
function calculateInitialPrice(realPrice) {
    const initialPrice = realPrice * 1.1;
    return Math.round(initialPrice / 10) * 15; // Round to the nearest 10
}

// ***index route***
exports.index = async (req, res, next) => {
  try {
      const query = req.query.q;
      const userId = req.user;
      const user = await User.findById(userId);
      const isProfileOwner = await User.findById(userId);
      const users = await User.find();
      const item = await Item.find({user:req.user});
      const promotedItems = await Item.find({ isPromoted: true });
      const bedsheets = await Item.find({ category: 'bedsheets' });
      const womenwear = await Item.find({ category: 'women wear' });
      const menwear = await Item.find({ category: 'men wear' });
      const menshoes = await Item.find({ category: 'men shoes' });
      const children = await Item.find({ category: 'children wear' });
      const ladies = await Item.find({ category: 'ladies wear' });
      const pillow = await Item.find({ category: 'pillow cases' });
      const african = await Item.find({ category: 'african wear' });
      const blowdry = await Item.find({ category: 'blowdry' });
      const decoration = await Item.find({ category: 'decoration crochet' });
      const ladiesshoes = await Item.find({ category: 'ladies shoes' });
      res.render('./item/index', { isProfileOwner, users, user, promotedItems, item, african, blowdry, decoration,
        bedsheets, womenwear, menwear, menshoes, children, ladies, pillow, ladiesshoes, calculateInitialPrice });
  } catch (error) {
    req.flash('error', 'There is problem getting data, please try again later.');
    return res.redirect('/');
  }
};


// ***create report route***
exports.create = async (req, res, next) => {
  try {
    const userId = req.user;
    const user = await User.findById(userId);
    const users = await User.find();
    const isProfileOwner = await User.findById(userId);
    const query = req.query.q;
    res.render('./Item/create', {user, query, users, isProfileOwner});
  } catch (error) {
    req.flash('error', 'There is problem getting your create page, please try again later.');
    return res.redirect('/profile');
  }
};


// ***store report route***
exports.store = async (req, res, next) => {

try {

  const token = req.session.token;
  if (!token) {
    req.flash('error', 'Your session has expired please login again.');
    return res.redirect('/login');
  }
  // Verify JWT token
  const decodedToken = jwt.verify(token, 'jwtSecret');
  const userId = decodedToken.userId;
  // Get user and account details
  const user = await User.findById(userId);
  const owner = req.user;

  const { itemname, category, price, description } = req.body;

  const image1 = req.files['image1'] ? req.files['image1'][0].filename : null;
  const image2 = req.files['image2'] ? req.files['image2'][0].filename : null;
  const image3 = req.files['image3'] ? req.files['image3'][0].filename : null;
  const image4 = req.files['image4'] ? req.files['image4'][0].filename : null;
  const image5 = req.files['image5'] ? req.files['image5'][0].filename : null;

  // If the image doesn't exist, save it to the database
  const item = new Item({ user:userId, owner, image1, image2, image3, image4, image5, itemname, price, category, description });
  user.Items.push(item);

  user.postCount += 1;
  // save report
  await Promise.all([item.save(), user.save()]);

  req.flash('success', 'You have successfully posted one item.');
  res.redirect('/create-item');

 } catch (error) {
    req.flash('error', 'There is problem posting item, please try again later.');
    res.redirect('/profile');
  }
};


// ***edit report route***
exports.edit = async (req, res, next) => {
  const userId = req.user;
  const user = await User.findById(userId);
  const users = await User.find();
  const isProfileOwner = await User.findById(userId);
  const { id } = req.params;
  const query = req.query.q;
  const item = await Item.findOne({ _id: id });
  res.render("./item/edit", {isProfileOwner, query, users, item, user });
};


// ***edit update route***
exports.update = async (req, res, next) => {
try {
  const { id } = req.params;
  const { itemname, category, price, description } = req.body;

  const image1 = req.files['image1'] ? req.files['image1'][0].filename : null;
  const image2 = req.files['image2'] ? req.files['image2'][0].filename : null;
  const image3 = req.files['image3'] ? req.files['image3'][0].filename : null;
  const image4 = req.files['image4'] ? req.files['image4'][0].filename : null;
  const image5 = req.files['image5'] ? req.files['image5'][0].filename : null;

  // Find the existing blog post by ID
  const existingPost = await Item.findById({ _id: id });
        if (!existingPost) {
          req.flash('error', 'The item you are trying to check is not available')
          return res.redirect('/profile');
        }

  // Delete the old image if a new image was uploaded
  if (image1 && existingPost.image1) {
    const imagePath = path.join(__dirname, '../public/uploads', existingPost.image1 || null);
    fs.unlinkSync(imagePath); // Delete the old image file
  }

  // Delete the old image if a new image was uploaded
  if (image2 && existingPost.image2) {
    const imagePath = path.join(__dirname, '../public/uploads', existingPost.image2);
    fs.unlinkSync(imagePath); // Delete the old image file
  }

  // Delete the old image if a new image was uploaded
  if (image3 && existingPost.image3) {
    const imagePath = path.join(__dirname, '../public/uploads', existingPost.image3);
    fs.unlinkSync(imagePath); // Delete the old image file
  }

  // Delete the old image if a new image was uploaded
  if (image4 && existingPost.image4) {
    const imagePath = path.join(__dirname, '../public/uploads', existingPost.image4);
    fs.unlinkSync(imagePath); // Delete the old image file
  }

  // Delete the old image if a new image was uploaded
  if (image5 && existingPost.image5) {
    const imagePath = path.join(__dirname, '../public/uploads', existingPost.image5);
    fs.unlinkSync(imagePath); // Delete the old image file
  }

  // Update the blog post with the new data
  existingPost.itemname = itemname;
  existingPost.description = description;
  existingPost.category = category;
  existingPost.price = price;
  existingPost.image1 = image1 || existingPost.image1; // Use the new image URL or keep the existing one
  existingPost.image2 = image2 || existingPost.image2;
  existingPost.image3 = image3 || existingPost.image3;
  existingPost.image4 = image4 || existingPost.image4;
  existingPost.image5 = image5 || existingPost.image5;
  // Save the updated blog post
  await existingPost.save();
  req.flash('success', 'You have successfully updated one item.');
  res.redirect('/item');

} catch (error) {
  req.flash('error', 'there is problem updating your item');
  return res.redirect('/profile');
  }
};


// ***route to show more ***
exports.show = async (req, res, next) => {
  const { id } = req.params;
  const query = req.query.q;
  const userId = req.user;
  const user = await User.findById(userId);
  const users = await User.find();
  const isProfileOwner = await User.findById(userId);
  const item = await Item.findOne({ _id: id });
  res.render("./item/itemmore", { query, isProfileOwner, item, user, users, userId, calculateInitialPrice });
};


// ***route for deleting image and associated text ***
exports.destroy = async (req, res, next) => {
  const postId = req.params.postId;
  const item = await Item.findById(postId);

  Item.findById(postId, (err, post) => {
    if (err || !post) {
      req.flash('error', 'The item you are trying to check is not available')
      return res.redirect('/profile');
    }

    if (postId) {
        // Check and delete images if they exist
        if (item.image) {
            fs.unlinkSync(path.join(__dirname, '../public/uploads', item.image));
        }
        if (item.image1) {
            fs.unlinkSync(path.join(__dirname, '../public/uploads', item.image1));
        }
        if (item.image2) {
            fs.unlinkSync(path.join(__dirname, '../public/uploads', item.image2));
        }
        if (item.image3) {
            fs.unlinkSync(path.join(__dirname, '../public/uploads', item.image3));
        }
        if (item.image4) {
            fs.unlinkSync(path.join(__dirname, '../public/uploads', item.image4));
        }

     }


    // Delete the post from the database
    Item.findByIdAndRemove(postId, (err) => {
      if (err) {
        req.flash('error', 'There is Error while deleting this product');
        return res.redirect('/profile');
      }
      req.flash('success', 'You have successfully deteted one item');
      res.redirect('/profile');
    });
  });
};


// Route to promote an item
exports.isPromoted = async (req, res, next) => {
  try {
    const item = await Item.findByIdAndUpdate(req.params.id, { isPromoted: true }, { new: true });
    req.flash('success', 'You have successfully promoted this product.');
    return res.redirect('/item');
  } catch (error) {
    req.flash('error', 'There is problem somewhere, please try it later');
    return res.redirect('/item');
  }
};


// Route to remove promotion from an item
exports.removePromotion = async (req, res) => {
  try {
    const item = await Item.findByIdAndUpdate(req.params.id, { isPromoted: false }, { new: true });
    req.flash('success', 'You have successfully removed one product from promotion list.');
    return res.redirect('/item');
  } catch (error) {
    req.flash('error', 'There is problem somewhere, please try it later');
    return res.redirect('/item');
  }
};

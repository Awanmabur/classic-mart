const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require("fs")
const Item = require('../models/Item');
const User = require('../models/User');
const jwt = require('jsonwebtoken');
const jwtSecret = process.env.PRIVATE_KEY;
const cloudinary = require('cloudinary').v2;
const sharp = require('sharp');

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
      res.render('./item/index', { isProfileOwner, users, user, promotedItems, item,
        phones, computers, electronics, garden, home, household,
        men, women, kids, baby, toy, pet, bags, crafts,
        beauty, health, automotive, appliances, food, industrial,
        jewelry, office, sports, musical, calculateInitialPrice
      });
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
    res.render('./item/create', {user, query, users, isProfileOwner});
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

  const { itemname, category, price, currency, description } = req.body;
  const files = req.files;
  // Upload each image and retrieve its public_id
  // Process images using sharp and upload to Cloudinary
const uploadedImages = await Promise.all(
 ['image1', 'image2', 'image3', 'image4', 'image5'].map(async (field) => {
   if (req.files[field]) {
     // Resize the image and convert to buffer
     const buffer = await sharp(req.files[field][0].buffer)
       .resize(800)
       .jpeg({ quality: 80 })
       .toBuffer();

     // Upload image buffer to Cloudinary
     return new Promise((resolve, reject) => {
       cloudinary.uploader.upload_stream(
         { folder: 'classic_mart' },
         (error, result) => {
           if (error) reject(error);
           else resolve(result.public_id);
         }
       ).end(buffer); // Use the processed buffer here
     });
   }
   return null; // Return null for optional images that are not uploaded
 })
);


  // If the image doesn't exist, save it to the database
  const item = new Item({
  user:userId, owner, currency,
  image1_id: uploadedImages[0],
  image2_id: uploadedImages[1],
  image3_id: uploadedImages[2],
  image4_id: uploadedImages[3] || null,
  image5_id: uploadedImages[4] || null,
  itemname, price, category, description
});

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
  const { itemname, category, price, currency, description } = req.body;

  // Find the existing blog post by ID
  const existingPost = await Item.findById({ _id: id });
        if (!existingPost) {
          req.flash('error', 'The item you are trying to check is not available')
          return res.redirect('/profile');
        }

  const files = req.files;
  const imageFields = ['image1', 'image2', 'image3', 'image4', 'image5'];
  // Update images if new ones are uploaded
  for (let i = 0; i < imageFields.length; i++) {
    const field = imageFields[i];
    if (files[field]) {
      // Delete the old image from Cloudinary
      if (existingPost[`${field}_id`]) {
        await cloudinary.uploader.destroy(existingPost[`${field}_id`]);
      }

      // Compress and upload the new image
      const buffer = await sharp(files[field][0].buffer)
        .resize(800)
        .jpeg({ quality: 80 })
        .toBuffer();

      // Upload the new image to Cloudinary
      const uploadedImage = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream({ folder: 'classic_mart' }, (error, result) => {
          if (error) reject(error);
          else resolve(result.public_id);
        }).end(buffer);
      });
      existingPost[`${field}_id`] = uploadedImage; // Update the public_id with the new image
    }
  }


  // Update the blog post with the new data
  existingPost.itemname = itemname;
  existingPost.description = description;
  existingPost.category = category;
  existingPost.price = price;
  existingPost.currency = currency;

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



// ** Route to delete a post and its associated images from Cloudinary **
exports.destroy = async (req, res, next) => {
  try {
    const post = req.params.postId;
    const item = await Item.findById(post);

    if (!post) {
          req.flash('error', 'The item you are trying to check is not available')
          return res.redirect('/profile');
        }
    // Collect all image public IDs to delete from Cloudinary
    const imageIds = [
      item.image1_id,
      item.image2_id,
      item.image3_id,
      item.image4_id,
      item.image5_id,
    ].filter(id => id); // Filter out any null values

    // Delete images from Cloudinary
    await Promise.all(imageIds.map(id => {
      return cloudinary.uploader.destroy(id);
    }));

    // Now delete the post from the database
    await Item.findByIdAndRemove(post);
    req.flash('success', 'You have successfully deteted one item');
    res.redirect('/profile');
  } catch (error) {
    req.flash('error', 'There is Error while deleting this product');
    return res.redirect('/profile');
  }
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

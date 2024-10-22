const express = require('express');
const router = express.Router();
const Item = require('../models/Item');
const User = require("../models/User");


// Add this function definition before app.get('/'...)
function calculateInitialPrice(realPrice) {
    const initialPrice = realPrice * 1.1;
    return Math.round(initialPrice / 10) * 15; // Round to the nearest 10
}

// ***index route***
exports.index = async (req, res, next) => {
  try {

    const userId = req.user;
    const user = await User.findById(userId);
    const deviceId = req.body.deviceId;
    const users = await User.find();
    const query = req.query.q;
    const oneUser = await User.find({image: user.image});
    const myPosts = await Item.countDocuments({user:req.user});
    const isProfileOwner = await User.findById(userId);

    const promotedItems = await Item.find({ isPromoted: true });
    const item = await Item.find({user:req.user});
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
    // Calculate the days left in the subscription
    let daysLeft = 0;
let totalDays = 0;
let percentageLeft = 0;
let subscriptionValid = false;

if (user.subscriptionExpiry) {
  const currentTime = Date.now();
  const expiryTime = user.subscriptionExpiry.getTime();

  if (expiryTime > currentTime) {
    subscriptionValid = true;

    // Calculate days left and total duration of subscription
    const timeLeft = expiryTime - currentTime;
    daysLeft = Math.ceil(timeLeft / (1000 * 60 * 60 * 24)); // Days left

    // Calculate total subscription duration in days (e.g., 30, 90, or 365 days)
    let subscriptionDuration = 0;
    if (user.subscriptionPlan === 'monthly') {
      subscriptionDuration = 30;
    } else if (user.subscriptionPlan === 'quarterly') {
      subscriptionDuration = 90;
    } else if (user.subscriptionPlan === 'annually') {
      subscriptionDuration = 365;
    }

    totalDays = subscriptionDuration;

    // Calculate percentage of days left
    percentageLeft = (daysLeft / totalDays) * 100;
  }
}

    res.render('./account/dashboard', { subscriptionValid, daysLeft, totalDays, percentageLeft, query, deviceId, isProfileOwner, userId, users, user, myPosts, oneUser, promotedItems, item, african, blowdry, decoration,
      bedsheets, womenwear, menwear, menshoes, children, ladies, pillow, ladiesshoes, calculateInitialPrice });
  } catch (error) {
    req.flash('error', 'There is problem getting your dashboard, please try again later.');
    return res.redirect('/');
  }
};


exports.subscription = async (req, res, next) => {
 try {
  const { plan } = req.body;
  const userId = req.user;
  const user = await User.findById(userId);

  // Set subscription expiry based on the selected plan
  let duration;
  switch (plan) {
    case 'monthly':
      duration = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds
      user.subscriptionPlan = 'monthly';
      break;
    case 'quarterly':
      duration = 90 * 24 * 60 * 60 * 1000; // 90 days
      user.subscriptionPlan = 'quarterly';
      break;
    case 'annually':
      duration = 365 * 24 * 60 * 60 * 1000; // 365 days
      user.subscriptionPlan = 'annually';
      break;
    default:
      return res.status(400).send('Invalid plan selected');
  }

  // Set the expiration date for the subscription
  user.subscriptionExpiry = new Date(Date.now() + duration);

  await user.save();

  req.flash('success', 'You have successfully subscribed.');
  res.redirect('/profile');
} catch (error) {
   req.flash('error', 'There is problem getting your dashboard, please try again later.');
   return res.redirect('/');
 }
};


// ***visit route***
exports.visit = async (req, res, next) => {
  try {

    const visit = await User.findById(req.params.id);
    const query = req.query.q;
    const userId = req.user;
     const currentUser = req.user;
    const user = await User.findById(visit);

    const deviceId = req.body.deviceId;
    const profileId = await User.findById(req.params.id);
    if (!visit) {
      req.flash('error', 'This profile is not available')
      return res.redirect('/');
    }

    const isProfileOwner = await User.findById(userId);
    const users = await User.find();
    const oneUser = await User.find({image: user.image});
    const myPosts = await Item.countDocuments({ owner: user._id });
    const promotedItems = await Item.find({ isPromoted: true });
    const item = await Item.find({user});
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

    res.render('./account/usersprofile', { currentUser, query, visit, deviceId, isProfileOwner, profileId, userId, users, user, myPosts, oneUser, promotedItems, item, african, blowdry, decoration,
      bedsheets, womenwear, menwear, menshoes, children, ladies, pillow, ladiesshoes, calculateInitialPrice });
 } catch (error) {
    req.flash('error', 'There is problem getting your dashboard, please try again later.');
    return res.redirect('/');
  }
};



exports.likes = async (req, res, next) => {

  try {

    const deviceId = req.deviceId;
    const user = await User.findById(req.params.id);

    if (!user) {
      req.flash('error', 'This profile is not available')
      return res.redirect('/');
    }

    const likedIndex = user.likedBy.indexOf(deviceId);

    if (likedIndex === -1) {
        user.likes += 1;
        user.likedBy.push(deviceId);
    } else {
        user.likes -= 1;
        user.likedBy.splice(likedIndex, 1);
    }

    await user.save();
    res.redirect(`/visit/${user.id}`);

  } catch (error) {
    req.flash('error', 'There is problem getting your dashboard, please try again later.');
    return res.redirect('/');
   }
 };



 exports.followers = async (req, res, next) => {

   try {

     const deviceId = req.deviceId;
     const user = await User.findById(req.params.id);

     if (!user) {
       req.flash('error', 'This profile is not available')
       return res.redirect('/');
     }

     const followedIndex = user.followedBy.indexOf(deviceId);

     if (followedIndex === -1) {
         user.followers += 1;
         user.followedBy.push(deviceId);
     } else {
         user.followers -= 1;
         user.followedBy.splice(followedIndex, 1);
     }

     await user.save();
     res.redirect(`/visit/${user.id}`);

   } catch (error) {
     req.flash('error', 'There is problem getting your dashboard, please try again later.');
     return res.redirect('/');
    }
  };



// ***edit report route***
exports.edit = async (req, res, next) => {
  const { id } = req.params;
  const query = req.query.q;
  const user = await User.findOne({ _id: id });
  const oneUser = await User.find({image: user.image});
  res.render("./account/edit", { query, user, oneUser });
};


// ***edit update route***
exports.update = async (req, res, next) => {
try {
  const { id } = req.params;
  const { bios, fname, lname, whatsapp, phonecall } = req.body;
  // Check if an image was uploaded
  let imageUrl;
  if (req.file) {
    imageUrl = req.file.filename;
  }

  if (req.fileValidationError) {
    return res.status(400).json({ error: req.fileValidationError });
  }
  // Check the size of the uploaded image
  if (imageUrl && req.file.size > 5 * 1024 * 1024) {
    fs.unlinkSync(req.file.path);
    req.flash('error', 'Image size exceeds the limit (2MB).');
    return res.redirect('/profile');
  }

  // Find the existing blog post by ID
  const existingPost = await User.findById({ _id: id });
        if (!existingPost) {
          req.flash('error', 'This post is not available')
          return res.redirect('/profile');
        }

  // Delete the old image if a new image was uploaded
  if (imageUrl && existingPost.image) {
    const imagePath = path.join(__dirname, '../public/uploads', existingPost.image);
    fs.unlinkSync(imagePath); // Delete the old image file
  }

  // Update the blog post with the new data
  existingPost.bios = bios;
  existingPost.fname = fname;
  existingPost.lname = lname;
  existingPost.whatsapp = whatsapp;
  existingPost.phonecall = phonecall;
  existingPost.image = imageUrl || existingPost.image; // Use the new image URL or keep the existing one

  // Save the updated blog post
  await existingPost.save();
  req.flash('success', 'You have successfully updated your profile.');
  res.redirect('/profile');

} catch (error) {
  req.flash('error', 'there is problem updating your post');
  return res.redirect('/profile');
}
};

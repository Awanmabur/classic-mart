const express = require('express');
const router = express.Router();
const Item = require('../models/Item');
const User = require("../models/User");
const cloudinary = require('cloudinary').v2;
const sharp = require('sharp');


// Add this function definition before app.get('/'...)
function calculateInitialPrice(realPrice) {
    const initialPrice = realPrice * 1.1;
    return Math.round(initialPrice / 10) * 15; // Round to the nearest 10
}


function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
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
    const shuffledPosts = shuffleArray([...item]);
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

    res.render('./account/dashboard', { subscriptionValid, daysLeft, totalDays, percentageLeft, query, deviceId, isProfileOwner, userId, users, user, myPosts, oneUser, promotedItems, item:shuffledPosts,
      phones, computers, electronics, garden, home, household,
      men, women, kids, baby, toy, pet, bags, crafts,
      beauty, health, automotive, appliances, food, industrial,
      jewelry, office, sports, musical, calculateInitialPrice
    });
  } catch (error) {
    req.flash('error', 'There is problem getting your dashboard, please try again later.');
    return res.redirect('/');
  }
};


exports.subscription = async (req, res, next) => {
 try {
  const { plan } = req.body;

  const email = req.body.email;
  // find user with email address
  const user = await User.findOne({ email:{ $regex: `^${email}$`, $options: 'i' } });
     if (!user) {
       req.flash('error', 'Email does not exists');
       return res.redirect('/signup');
  }

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
    const user = await User.find();

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
    const shuffledPosts = shuffleArray([...item]);
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

    res.render('./account/usersprofile', { currentUser, query, visit, deviceId, isProfileOwner, profileId, userId, users, user, myPosts, oneUser, promotedItems, item:shuffledPosts, african, blowdry, decoration,
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
  // Find the existing blog post by ID
  const existingPost = await User.findById({ _id: id });
        if (!existingPost) {
          req.flash('error', 'The item you are trying to check is not available')
          return res.redirect('/profile');
        }

        const file = req.file; // Assuming you're using a single file upload (e.g., `upload.single('image')` in multer)

       // Check if a new image was uploaded
       if (file) {
         // Delete the old image from Cloudinary if it exists
         if (existingPost.image_id) {
           await cloudinary.uploader.destroy(existingPost.image_id);
         }

         // Compress and upload the new image
         const buffer = await sharp(file.buffer)
           .resize(800)
           .jpeg({ quality: 80 })
           .toBuffer();

         // Upload the new image to Cloudinary
         const uploadedImage = await new Promise((resolve, reject) => {
           cloudinary.uploader.upload_stream(
             { folder: 'classic_mart' },
             (error, result) => {
               if (error) reject(error);
               else resolve(result.public_id);
             }
           ).end(buffer);
         });

         // Update the public_id with the new image
         existingPost.image_id = uploadedImage;
       }

  // Update the blog post with the new data
  existingPost.bios = bios;
  existingPost.fname = fname;
  existingPost.lname = lname;
  existingPost.whatsapp = whatsapp;
  existingPost.phonecall = phonecall;

  // Save the updated blog post
  await existingPost.save();
  req.flash('success', 'You have successfully updated one item.');
  res.redirect('/profile');

} catch (error) {
  req.flash('error', 'there is problem updating your item');
  return res.redirect('/profile');
  }
};
